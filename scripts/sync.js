var mongoose = require('mongoose')
  , lib = require('../lib/explorer')
  , db = require('../lib/database')
  , Tx = require('../models/tx')
  , Address = require('../models/address')
  , AddressTx = require('../models/addresstx')
  , Richlist = require('../models/richlist')
  , Stats = require('../models/stats')
  , settings = require('../lib/settings');

var mode = 'update';
var database = 'index';

// displays usage and exits
function usage() {
  console.log('Usage: scripts/sync.sh /path/to/nodejs [mode]');
  console.log('');
  console.log('Mode: (required)');
  console.log('update           Updates index from last sync to current block');
  console.log('check            Checks index for (and adds) any missing transactions/addresses');
  console.log('reindex          Clears index then resyncs from genesis to current block');
  console.log('reindex-rich     Clears and recreates the richlist data');  
  console.log('reindex-txcount  Rescan and flatten the tx count value for faster access');
  console.log('market           Updates market summaries, orderbooks, trade history + charts');
  console.log('peers            Updates peer info based on local wallet connections');
  console.log('masternodes      Updates the list of active masternodes on the network');
  console.log('');
  console.log('Notes:');
  console.log('- \'current block\' is the latest created block when script is executed.');
  console.log('- The market + peers databases only support (& defaults to) reindex mode.');
  console.log('- If check mode finds missing data (ignoring new data since last sync),');
  console.log('  index_timeout in settings.json is set too low.')
  console.log('');
  process.exit(0);
}

// check options
if (process.argv[2] == 'index') {
  if (process.argv.length <3) {
    usage();
  } else {
    switch(process.argv[3])
    {
      case 'update':
        mode = 'update';
        break;
      case 'check':
        mode = 'check';
        break;
      case 'reindex':
        mode = 'reindex';
        break;
      case 'reindex-rich':
        mode = 'reindex-rich';
        break;
      case 'reindex-txcount':
        mode = 'reindex-txcount';
        break;
      default:
        usage();
    }
  }
} else if (process.argv[2] == 'market') {
  database = 'market';
} else if (process.argv[2] == 'peers') {
  database = 'peers';
} else if (process.argv[2] == 'masternodes') {
  database = 'masternodes';
} else {
  usage();
}

function create_lock(cb) {
  if ( database == 'index' ) {
    var fname = './tmp/' + database + '.pid';
    db.fs.appendFile(fname, process.pid.toString(), function (err) {
      if (err) {
        console.log("Error: unable to create %s", fname);
        process.exit(1);
      } else {
        return cb();
      }
    });
  } else {
    return cb();
  }
}

function remove_lock(cb) {
  if ( database == 'index' ) {
    var fname = './tmp/' + database + '.pid';
    db.fs.unlink(fname, function (err) {
      if(err) {
        console.log("unable to remove lock: %s", fname);
        process.exit(1);
      } else {
        return cb();
      }
    });
  } else {
    return cb();
  }
}

function is_locked(cb) {
  if ( database == 'index' ) {
    var fname = './tmp/' + database + '.pid';
    db.fs.exists(fname, function (exists) {
      if(exists) {
        return cb(true);
      } else {
        return cb(false);
      }
    });
  } else {
    return cb();
  }
}

function exit() {
  remove_lock(function(){
    mongoose.disconnect();
    process.exit(0);
  });
}

var dbString = 'mongodb://' + settings.dbsettings.user;
dbString = dbString + ':' + settings.dbsettings.password;
dbString = dbString + '@' + settings.dbsettings.address;
dbString = dbString + ':' + settings.dbsettings.port;
dbString = dbString + '/' + settings.dbsettings.database;

if (database == 'peers') {
  console.log('syncing peers.. please wait..');
  // Initialize the rate limiting class from Matteo Agosti via https://www.matteoagosti.com/blog/2013/01/22/rate-limiting-function-calls-in-javascript/
  var RateLimit = (function() {
    var RateLimit = function(maxOps, interval, allowBursts) {
      this._maxRate = allowBursts ? maxOps : maxOps / interval;
      this._interval = interval;
      this._allowBursts = allowBursts;

      this._numOps = 0;
      this._start = new Date().getTime();
      this._queue = [];
    };

    RateLimit.prototype.schedule = function(fn) {
      var that = this,
          rate = 0,
          now = new Date().getTime(),
          elapsed = now - this._start;

      if (elapsed > this._interval) {
        this._numOps = 0;
        this._start = now;
      }

      rate = this._numOps / (this._allowBursts ? 1 : elapsed);

      if (rate < this._maxRate) {
        if (this._queue.length === 0) {
          this._numOps++;
          fn();
        }
        else {
          if (fn) this._queue.push(fn);

          this._numOps++;
          this._queue.shift()();
        }
      }
      else {
        if (fn) this._queue.push(fn);

        setTimeout(function() {
          that.schedule();
        }, 1 / this._maxRate);
      }
    };

    return RateLimit;
  })();
  // syncing peers does not require a lock
  mongoose.connect(dbString, { useNewUrlParser: true, useCreateIndex: true, useUnifiedTopology: true, useFindAndModify: false }, function(err) {
    if (err) {
      console.log('Unable to connect to database: %s', dbString);
      console.log('Aborting');
      exit();
    } else {
      lib.get_peerinfo(function (body) {
        if (body != null) {
          lib.syncLoop(body.length, function (loop) {
            var i = loop.iteration();
            var address = body[i].addr.substring(0, body[i].addr.lastIndexOf(":")).replace("[","").replace("]","");
            var port = body[i].addr.substring(body[i].addr.lastIndexOf(":") + 1);
            var rateLimit = new RateLimit(1, 2000, false);
            db.find_peer(address, function(peer) {
              if (peer) {
                if (isNaN(peer['port']) || peer['port'].length < 2 || peer['country'].length < 1 || peer['country_code'].length < 1) {
                  db.drop_peers(function() {
                    console.log('Saved peers missing ports or country, dropping peers. Re-run this script afterwards.');
                    exit();
                  });
                }
                // peer already exists
                loop.next();
              } else {
                rateLimit.schedule(function() {
                  lib.get_geo_location(address, function (error, geo) {
                    // check if an error was returned
                    if (error) {
                      console.log(error);
                      exit();
                    } else {
                      // add peer to collection
                      db.create_peer({
                        address: address,
                        port: port,
                        protocol: body[i].version,
                        version: body[i].subver.replace('/', '').replace('/', ''),
                        country: geo.country_name,
                        country_code: geo.country_code
                      }, function() {
                        loop.next();
                      });
                    }
                  });
                });
              }
            });
          }, function() {
            // update network_last_updated value
            db.update_last_updated_stats(settings.coin, { network_last_updated: Math.floor(new Date() / 1000) }, function (cb) {
              console.log('peer sync complete');
              exit();
            });
          });
        } else {
          console.log('no peers found');
          exit();
        }
      });
    }
  });
} else if (database == 'masternodes') {
  console.log('syncing masternodes.. please wait..');
  // syncing masternodes does not require a lock
  mongoose.connect(dbString, { useNewUrlParser: true, useCreateIndex: true, useUnifiedTopology: true, useFindAndModify: false }, function(err) {
    if (err) {
      console.log('Unable to connect to database: %s', dbString);
      console.log('Aborting');
      exit();
    } else {
      lib.get_masternodelist(function (body) {
        if (body != null) {
          lib.syncLoop(body.length, function (loop) {
            var i = loop.iteration();
            db.save_masternode(body[i], function (success) {
              if (success)
                loop.next();
              else {
                console.log('error: cannot save masternode %s.', (body[i].addr ? body[i].addr : 'UNKNOWN'));
                exit();
              }
            });
          }, function () {
            db.remove_old_masternodes(function (cb) {
              db.update_last_updated_stats(settings.coin, { masternodes_last_updated: Math.floor(new Date() / 1000) }, function (cb) {
                console.log('masternode sync complete');
                exit();
              });
            });
          });
        } else {
          console.log('no masternodes found');
          exit();
        }
      });
    }
  });
} else {
  // index and market sync requires locking
  is_locked(function (exists) {
    if (exists) {
      console.log("Script already running..");
      process.exit(0);
    } else {
      create_lock(function (){
        console.log("script launched with pid: " + process.pid);
        mongoose.connect(dbString, { useNewUrlParser: true, useCreateIndex: true, useUnifiedTopology: true, useFindAndModify: false }, function(err) {
          if (err) {
            console.log('Unable to connect to database: %s', dbString);
            console.log('Aborting');
            exit();
          } else if (database == 'index') {
            db.check_stats(settings.coin, function(exists) {
              if (exists == false) {
                console.log('Run \'npm start\' to create database structures before running this script.');
                exit();
              } else {
                db.update_db(settings.coin, function(stats){
                  if (settings.heavy == true)
                    db.update_heavy(settings.coin, stats.count, 20, function() {});
                  if (mode == 'reindex') {
                    Tx.deleteMany({}, function(err) {
                      console.log('TXs cleared.');
                      Address.deleteMany({}, function(err2) {
                        console.log('Addresses cleared.');
                        AddressTx.deleteMany({}, function(err3) {
                          console.log('Address TXs cleared.');
                          Richlist.updateOne({coin: settings.coin}, {
                            received: [],
                            balance: [],
                          }, function(err3) {
                            Stats.updateOne({coin: settings.coin}, {
                              last: 0,
                              count: 0,
                              supply: 0
                            }, function() {
                              console.log('index cleared (reindex)');
                            });

                            // Check if there are more than 1000 blocks to index and show a sync msg
                            check_show_sync_message(stats.count);

                            db.update_tx_db(settings.coin, 1, stats.count, stats.txes, settings.update_timeout, function() {
                              db.update_richlist('received', function() {
                                db.update_richlist('balance', function() {
                                  db.get_stats(settings.coin, function(nstats) {
                                    // always check for and remove the sync msg if exists
                                    remove_sync_message();
                                    // update richlist_last_updated value
                                    db.update_last_updated_stats(settings.coin, { richlist_last_updated: Math.floor(new Date() / 1000) }, function (cb) {
                                      // update blockchain_last_updated value
                                      db.update_last_updated_stats(settings.coin, { blockchain_last_updated: Math.floor(new Date() / 1000) }, function (cb) {
                                        console.log('reindex complete (block: %s)', nstats.last);
                                        exit();
                                      });
                                    });
                                  });
                                });
                              });
                            });
                          });
                        });
                      });
                    });
                  } else if (mode == 'check') {
                    console.log('starting check.. please wait..');
                    db.update_tx_db(settings.coin, 1, stats.count, stats.txes, settings.check_timeout, function(){
                      db.get_stats(settings.coin, function(nstats){
                        console.log('check complete (block: %s)', nstats.last);
                        exit();
                      });
                    });
                  } else if (mode == 'update') {
                    // Get the last synced block index value
                    var last = (stats.last ? stats.last : 0);
                    // Get the total number of blocks
                    var count = (stats.count ? stats.count : 0);
                    // Check if there are more than 1000 blocks to index and show a sync msg
                    check_show_sync_message(count - last);

                    db.update_tx_db(settings.coin, last, count, stats.txes, settings.update_timeout, function(){
                      db.update_richlist('received', function(){
                        db.update_richlist('balance', function(){
                          db.get_stats(settings.coin, function(nstats){
                            // always check for and remove the sync msg if exists
                            remove_sync_message();
                            // update richlist_last_updated value
                            db.update_last_updated_stats(settings.coin, { richlist_last_updated: Math.floor(new Date() / 1000) }, function (cb) {
                              // update blockchain_last_updated value
                              db.update_last_updated_stats(settings.coin, { blockchain_last_updated: Math.floor(new Date() / 1000) }, function (cb) {
                                console.log('update complete (block: %s)', nstats.last);
                                exit();
                              });
                            });
                          });
                        });
                      });
                    });
                  } else if (mode == 'reindex-rich') {
                    console.log('check richlist');
                    db.check_richlist(settings.coin, function(exists) {
                      if (exists) console.log('richlist entry found, deleting now..');
                      db.delete_richlist(settings.coin, function(deleted) {
                        if (deleted) console.log('richlist entry deleted');
                        db.create_richlist(settings.coin, function() {
                          console.log('richlist created.');
                          db.update_richlist('received', function() {
                            console.log('richlist updated received.');
                            db.update_richlist('balance', function() {
                              // update richlist_last_updated value
                              db.update_last_updated_stats(settings.coin, { richlist_last_updated: Math.floor(new Date() / 1000) }, function (cb) {
                                console.log('richlist update complete');
                                exit();
                              });
                            });
                          });
                        });
                      });
                    });
                  } else if (mode == 'reindex-txcount') {
                    console.log('calculating tx count.. please wait..');
                    // Resetting the transaction counter requires a single lookup on the txes collection to find all txes that have a positive or zero total and 1 or more vout
                    Tx.find({'total': {$gte: 0}, 'vout': { $gte: { $size: 1 }}}).countDocuments(function(err, count) {
                      console.log('found tx count: ' + count.toString());
                      Stats.updateOne({coin: settings.coin}, {
                        txes: count
                      }, function() {
                        console.log('tx count update complete');
                        exit();
                      });
                    });
                  } else if (mode == 'reindex-last') {
                    console.log('calculating last tx.. please wait..');
                    // Resetting the last counter requires a single lookup on the txes collection to find all txes that have a positive or zero total and 1 or more vout
                    Tx.find({'total': {$gte: 0}, 'vout': { $gte: { $size: 1 }}}).countDocuments(function(err, count) {
                      console.log('found tx count: ' + count.toString());
                      Stats.updateOne({coin: settings.coin}, {
                        txes: count
                      }, function() {
                        console.log('tx count update complete');
                        exit();
                      });
                    });
                  }
                });
              }
            });
          } else {
            //update markets
            var markets = settings.markets.enabled;
            var complete = 0;
            for (var x = 0; x < markets.length; x++) {
              // check if market is installed
              if (db.fs.existsSync('./lib/markets/' + markets[x] + '.js')) {
                db.check_market(markets[x], function(mkt, exists) {
                  if (exists) {
                    db.update_markets_db(mkt, function(err) {
                      if (!err) {
                        console.log('%s market data updated successfully.', mkt);
                        complete++;
                        if (complete == markets.length)
                          get_last_usd_price();
                      } else {
                        console.log('%s: %s', mkt, err);
                        complete++;
                        if (complete == markets.length)
                          get_last_usd_price();
                      }
                    });
                  } else {
                    console.log('error: entry for %s does not exists in markets db.', mkt);
                    complete++;
                    if (complete == markets.length)
                    get_last_usd_price();
                  }
                });
              } else {
                // market not installed
                console.log('%s %s', markets[x], 'market not installed');
                complete++;
                if (complete == markets.length)
                  get_last_usd_price();
              }
            }
          }
        });
      });
    }
  });
}

function check_show_sync_message(blocks_to_sync) {
  var retVal = false;
  var filePath = './tmp/show_sync_message.tmp';
  // Check if there are more than 1000 blocks to index
  if (blocks_to_sync > 1000) {
    // Check if the show sync stub file already exists
    if (!db.fs.existsSync(filePath)) {
      // File doesn't exist, so create it now
      db.fs.writeFileSync(filePath, '');
    }

    retVal = true;
  }

  return retVal;
}

function remove_sync_message() {
  var filePath = './tmp/show_sync_message.tmp';
  // Check if the show sync stub file exists
  if (db.fs.existsSync(filePath)) {
    // File exists, so delete it now
    try {
      db.fs.unlinkSync(filePath);
    } catch (err) {
      console.log(err);
    }
  }
}

function get_last_usd_price() {
  // Get the last usd price for coinstats
  db.get_last_usd_price(function(retVal) {
    // update markets_last_updated value
    db.update_last_updated_stats(settings.coin, { markets_last_updated: Math.floor(new Date() / 1000) }, function (cb) {
      console.log('market sync complete');
      exit();
    });
  });
}