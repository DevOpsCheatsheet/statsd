var fs           = require('fs'),
    net          = require('net'),
    temp         = require('temp'),
    spawn        = require('child_process').spawn,
    util          = require('util'),
    urlparse     = require('url').parse,
    _            = require('underscore'),
    dgram        = require('dgram'),
    qsparse      = require('querystring').parse,
    test_helpers = require('../lib/test_helpers'),
    http         = require('http');

module.exports = {
  setUp: function (callback) {
    this.testport = 31337;
    this.myflush = 200;
    var configfile = "{graphService: \"graphite\"\n\
               ,  batch: 200 \n\
               ,  flushInterval: " + this.myflush + " \n\
               ,  percentThreshold: 90\n\
               ,  histogram: [ { metric: \"a_test_value\", bins: [1000] } ]\n\
               ,  port: 8125\n\
               ,  dumpMessages: false \n\
               ,  debug: false\n\
               ,  graphite: { legacyNamespace: false }\n\
               ,  graphitePort: " + this.testport + "\n\
               ,  graphiteHost: \"127.0.0.1\"}";

    this.acceptor = net.createServer();
    this.acceptor.listen(this.testport);
    this.sock = dgram.createSocket('udp4');

    this.server_up = true;
    this.ok_to_die = false;
    this.exit_callback_callback = process.exit;

    test_helpers.writeconfig(configfile,function(path,cb,obj){
      obj.path = path;
      obj.server = spawn('node',['stats.js', path]);
      obj.exit_callback = function (code) {
        obj.server_up = false;
        if(!obj.ok_to_die){
          console.log('node server unexpectedly quit with code: ' + code);
          process.exit(1);
        }
        else {
          obj.exit_callback_callback();
        }
      };
      obj.server.on('exit', obj.exit_callback);
      obj.server.stderr.on('data', function (data) {
        console.log('stderr: ' + data.toString().replace(/\n$/,''));
      });
      /*
      obj.server.stdout.on('data', function (data) {
        console.log('stdout: ' + data.toString().replace(/\n$/,''));
      });
      */
      obj.server.stdout.on('data', function (data) {
        // wait until server is up before we finish setUp
        if (data.toString().match(/server is up/)) {
          cb();
        }
      });

    },callback,this);
  },
  tearDown: function (callback) {
    this.sock.close();
    this.acceptor.close();
    this.ok_to_die = true;
    if(this.server_up){
      this.exit_callback_callback = callback;
      this.server.kill();
    } else {
      callback();
    }
  },

  send_well_formed_posts: function (test) {
    test.expect(2);

    this.acceptor.once('connection',function(c){
      var body = '';
      c.on('data',function(d){ body += d; });
      setTimeout(function(){
        var rows = body.split("\n");
        var entries = _.map(rows, function(x) {
          var chunks = x.split(' ');
          var data = {};
          data[chunks[0]] = chunks[1];
          return data;
        });
        test.ok(_.include(_.map(entries,function(x) { return _.keys(x)[0] }),'stats.statsd.numStats'),'graphite output includes numStats');
        test.equal(_.find(entries, function(x) { return _.keys(x)[0] == 'stats.statsd.numStats' })['stats.statsd.numStats'],2);
        test.done();
      }, 200);
    });
  },

  send_malformed_post: function (test) {
    test.expect(3);

    var testvalue = 1;
    var me = this;
    this.acceptor.once('connection',function(c){
      test_helpers.statsd_send('a_bad_test_value|z',me.sock,'127.0.0.1',8125,function(){
          test_helpers.collect_for(c,me.myflush*2,function(strings){
            test.ok(strings.length > 0,'should receive some data');
            var hashes = _.map(strings, function(x) {
              var chunks = x.split(' ');
              var data = {};
              data[chunks[0]] = chunks[1];
              return data;
            });
            var numstat_test = function(post){
              var mykey = 'stats.statsd.numStats';
              return _.include(_.keys(post),mykey) && (post[mykey] == 3);
            };
            test.ok(_.any(hashes,numstat_test), 'statsd.numStats should be 3');

            var bad_lines_seen_value_test = function(post){
              var mykey = 'stats.counters.statsd.bad_lines_seen.count';
              return _.include(_.keys(post),mykey) && (post[mykey] == testvalue);
            };
            test.ok(_.any(hashes,bad_lines_seen_value_test), 'stats.counters.statsd.bad_lines_seen.count should be ' + testvalue);

            test.done();
          });
      });
    });
  },

  timers_are_valid: function (test) {
    test.expect(6);

    var testvalue = 100;
    var me = this;
    this.acceptor.once('connection',function(c){
      test_helpers.statsd_send('a_test_value:' + testvalue + '|ms',me.sock,'127.0.0.1',8125,function(){
          test_helpers.collect_for(c,me.myflush*2,function(strings){
            test.ok(strings.length > 0,'should receive some data');
            var hashes = _.map(strings, function(x) {
              var chunks = x.split(' ');
              var data = {};
              data[chunks[0]] = chunks[1];
              return data;
            });
            var numstat_test = function(post){
              var mykey = 'stats.statsd.numStats';
              return _.include(_.keys(post),mykey) && (post[mykey] == 4);
            };
            test.ok(_.any(hashes,numstat_test), 'stats.statsd.numStats should be 4');

            var testtimervalue_test = function(post){
              var mykey = 'stats.timers.a_test_value.mean_90';
              return _.include(_.keys(post),mykey) && (post[mykey] == testvalue);
            };
            var testtimerhistogramvalue_test = function(post){
              var mykey = 'stats.timers.a_test_value.histogram.bin_1000';
              return _.include(_.keys(post),mykey) && (post[mykey] == 1);
            };
            test.ok(_.any(hashes,testtimerhistogramvalue_test), 'stats.timers.a_test_value.mean should be ' + 1);
            test.ok(_.any(hashes,testtimervalue_test), 'stats.timers.a_test_value.mean should be ' + testvalue);

            var count_test = function(post, metric){
              var mykey = 'stats.timers.a_test_value.' + metric;
              return _.first(_.filter(_.pluck(post, mykey), function (e) { return e }));
            };
            test.equals(count_test(hashes, 'count_ps'), 5, 'count_ps should be 5');
            test.equals(count_test(hashes, 'count'), 1, 'count should be 1');

            test.done();
          });
      });
    });
  },

  sampled_timers_are_valid: function (test) {
    test.expect(2);

    var testvalue = 100;
    var me = this;
    this.acceptor.once('connection',function(c){
      test_helpers.statsd_send('a_test_value:' + testvalue + '|ms|@0.1',me.sock,'127.0.0.1',8125,function(){
          test_helpers.collect_for(c,me.myflush*2,function(strings){
            var hashes = _.map(strings, function(x) {
              var chunks = x.split(' ');
              var data = {};
              data[chunks[0]] = chunks[1];
              return data;
            });
            var count_test = function(post, metric){
              var mykey = 'stats.timers.a_test_value.' + metric;
              return _.first(_.filter(_.pluck(post, mykey), function (e) { return e }));
            };
            test.equals(count_test(hashes, 'count_ps'), 50, 'count_ps should be 50');
            test.equals(count_test(hashes, 'count'), 10, 'count should be 10');
            test.done();
          });
      });
    });
  },

  counts_are_valid: function (test) {
    test.expect(4);

    var testvalue = 100;
    var me = this;
    this.acceptor.once('connection',function(c){
      test_helpers.statsd_send('a_test_value:' + testvalue + '|c',me.sock,'127.0.0.1',8125,function(){
          test_helpers.collect_for(c,me.myflush*2,function(strings){
            test.ok(strings.length > 0,'should receive some data');
            var hashes = _.map(strings, function(x) {
              var chunks = x.split(' ');
              var data = {};
              data[chunks[0]] = chunks[1];
              return data;
            });
            var numstat_test = function(post){
              var mykey = 'stats.statsd.numStats';
              return _.include(_.keys(post),mykey) && (post[mykey] == 4);
            };
            test.ok(_.any(hashes,numstat_test), 'statsd.numStats should be 4');

            var testavgvalue_test = function(post){
              var mykey = 'stats.counters.a_test_value.rate';
              return _.include(_.keys(post),mykey) && (post[mykey] == (testvalue/(me.myflush / 1000)));
            };
            test.ok(_.any(hashes,testavgvalue_test), 'a_test_value.rate should be ' + (testvalue/(me.myflush / 1000)));

            var testcountvalue_test = function(post){
              var mykey = 'stats.counters.a_test_value.count';
              return _.include(_.keys(post),mykey) && (post[mykey] == testvalue);
            };
            test.ok(_.any(hashes,testcountvalue_test), 'a_test_value.count should be ' + testvalue);

            test.done();
          });
      });
    });
  },

  gauges_are_valid: function(test) {
    test.expect(2);

    var testvalue = 70;
    var me = this;
    this.acceptor.once('connection', function(c) {
      test_helpers.statsd_send('a_test_value:' + testvalue + '|g', me.sock, '127.0.0.1', 8125, function() {
        test_helpers.collect_for(c, me.myflush*2, function(strings) {
          test.ok(strings.length > 0, 'should receive some data');
          var hashes = _.map(strings, function(x) {
            var chunks = x.split(' ');
            var data = {};
            data[chunks[0]] = chunks[1];
            return data;
          });

          var gaugevalue_test = function(post) {
            var mykey = 'stats.gauges.a_test_value';
            return _.include(_.keys(post), mykey) && (post[mykey] == testvalue);
          };
          test.ok(_.any(hashes, gaugevalue_test), 'stats.gauges.a_test_value should be ' + testvalue);

          test.done();
        });
      });
    });
  },

  gauge_modifications_are_valid: function(test) {
    test.expect(2);

    var teststartvalue = 50;
    var testdeltavalue = '-3';
    var testresult = teststartvalue + Number(testdeltavalue);
    var me = this;
    this.acceptor.once('connection', function(c) {
      test_helpers.statsd_send('test_value:' + teststartvalue + '|g', me.sock, '127.0.0.1', 8125, function() {
        test_helpers.statsd_send('test_value:' + testdeltavalue + '|g', me.sock, '127.0.0.1', 8125, function() {
          test_helpers.collect_for(c, me.myflush * 2, function(strings) {
            test.ok(strings.length > 0, 'should receive some data');
            var hashes = _.map(strings, function(x) {
              var chunks = x.split(' ');
              var data = {};
              data[chunks[0]] = chunks[1];
              return data;
            });

            var gaugevalue_test = function(post) {
              var mykey = 'stats.gauges.test_value';
              return _.include(_.keys(post), mykey) && (post[mykey] == testresult);
            };
            test.ok(_.any(hashes, gaugevalue_test), 'stats.gauges.test_value should be ' + testresult);

            test.done();
          });
        });
      });
    });
  },
  connection_is_reused: function(test) {
    var me = this;
    this.acceptor.once('connection',function(c){
      //raise an error if we ever get a disconnect event
      c.on('end', function() {
        throw new Error('socket has been closed, should have been reused.');
      });
      //make sure we get data multiple times over the same socket
      test_helpers.collect_for(c,me.myflush*5,function(strings){
        test.ok(strings.length > 0,'should get some data');

        test_helpers.collect_for(c,me.myflush*5,function(strings){
          test.ok(strings.length > 0 ,'should get more data from the same connection');
          //the socket will automatically be closed at the end of the test, do not emit
          //'end'
          c.removeAllListeners('end');
          test.done();
        });
      });
    });
  }
}
