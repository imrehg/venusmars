require.paths.unshift(__dirname + '/lib');

var everyauth = require('everyauth');
var express   = require('express');

var FacebookClient = require('facebook-client').FacebookClient;
var facebook = new FacebookClient();

var uuid = require('node-uuid');

// configure facebook authentication
everyauth.facebook
  .appId(process.env.FACEBOOK_APP_ID)
  .appSecret(process.env.FACEBOOK_SECRET)
  .scope('friends_status')
  .entryPath('/')
  .redirectPath('/home')
  .findOrCreateUser(function() {
    return({});
  });

// create an express webserver
var app = express.createServer(
  express.logger(),
  express.static(__dirname + '/public'),
  express.cookieParser(),
  // set this to a secret value to encrypt session cookies
  express.session({ secret: process.env.SESSION_SECRET || 'secret123' }),
  // insert a middleware to set the facebook redirect hostname to http/https dynamically
  function(request, response, next) {
    var method = request.headers['x-forwarded-proto'] || 'http';
    everyauth.facebook.myHostname(method + '://' + request.headers.host);
    next();
  },
  everyauth.middleware(),
  require('facebook').Facebook()
);

// listen to the PORT given to us in the environment
var port = process.env.PORT || 3000;

app.listen(port, function() {
  console.log("Listening on " + port);
});

// create a socket.io backend for sending facebook graph data
// to the browser as we receive it
var io = require('socket.io').listen(app);

// wrap socket.io with basic identification and message queueing
// code is in lib/socket_manager.js
var socket_manager = require('socket_manager').create(io);

// use xhr-polling as the transport for socket.io
io.configure(function () {
  io.set("transports", ["xhr-polling"]);
  io.set("polling duration", 10);
});

// respond to GET /home
app.get('/home', function(request, response) {

  // detect the http method uses so we can replicate it on redirects
  var method = request.headers['x-forwarded-proto'] || 'http';

  // if we have facebook auth credentials
  if (request.session.auth) {

    // initialize facebook-client with the access token to gain access
    // to helper methods for the REST api
    var token = request.session.auth.facebook.accessToken;
    facebook.getSessionByAccessToken(token)(function(session) {

      // generate a uuid for socket association
      var socket_id = uuid();

      var queries =  "{'friends': 'SELECT uid2 FROM friend WHERE uid1 = me()','gender': 'SELECT uid,name,sex,pic_square FROM user WHERE uid in (SELECT uid2 from #friends)','status': 'SELECT uid,message FROM status WHERE uid in (SELECT uid2 from #friends)'}";
      // use fql to get status updates
      session.restCall('fql.multiquery', {
        "queries": queries,
        "format": 'json'
      })(function(result) {
	var finfo = {};
        var friendset = result[1].fql_result_set;
	// process gender information
	for (var i in friendset) {
	    var friend = friendset[i];
            if (friend.sex == 'male' || friend.sex == 'female') {
		finfo[friend.uid] = friend;
	    } else {
		console.log(friend.name + ' haven\'t set their sex');
	    }
	}
        // send tagged status updates
	var statuses = result[2].fql_result_set;
	for (var i in statuses) {
	    var status = statuses[i];
            if (finfo[status.uid]) {
		var toclient = {sender: finfo[status.uid],
				status: status};
		socket_manager.send(socket_id, 'friends_status', toclient);
	    }
	}
      });

      // get information about the app itself
      session.graphCall('/' + process.env.FACEBOOK_APP_ID)(function(app) {

        // render the home page
        response.render('home.ejs', {
          layout:   false,
          token:    token,
          app:      app,
          user:     request.session.auth.facebook.user,
          home:     method + '://' + request.headers.host + '/',
          redirect: method + '://' + request.headers.host + request.url,
          socket_id: socket_id
        });

      });
    });

  } else {

    // not authenticated, redirect to / for everyauth to begin authentication
    response.redirect('/');

  }
});
