var conf = { 
    port: 8888,
    debug: false,
    dbPort: 9469,
    dbHost: 'greeneye.redistogo.com',
    dbOptions: {},
    mainroom: 'MainRoom'
};

// External dependencies
var express = require('express'),
    http = require('http'),
    events = require('events'),
    _ = require('underscore'),
    sanitize = require('validator').sanitize;

// HTTP Server configuration & launch
var app = express(),
    server = http.createServer(app);
    server.listen(conf.port);

// Express app configuration
app.configure(function() {
    app.use(express.bodyParser());
    app.use(express.static(__dirname + '/static'));
});

var io = require('socket.io')(server);
var adapter = require('socket.io-redis');

io.adapter(adapter({ host: conf.dbHost, port: conf.dbPort }));

var db = require('redis').createClient();

if (process.env.REDISTOGO_URL) {
    console.log("RedisTOGO Active");
    var rtg = require("url").parse(process.env.REDISTOGO_URL);
    var db = require('redis').createClient(rtg.port, rtg.hostname);
    db.auth(rtg.auth.split(":")[1]);
} else {
    var db = require("redis").createClient(conf.dbPort, conf.dbHost);
}

// Logger configuration
var logger = new events.EventEmitter();
logger.on('newEvent', function(event, data) {
    // Console log
    console.log('%s: %s', event, JSON.stringify(data));
    // Persistent log storage too?
    // TODO
});

// ***************************************************************************
// Express routes helpers
// ***************************************************************************

// Only authenticated users should be able to use protected methods
var requireAuthentication = function(req, res, next) {
    // TODO
    next();
};

// Send a message to all active rooms
var sendBroadcast = function(text) {
    _.each(io.nsps['/'].adapter.rooms, function(sockets, room) {
        var message = {'room':room, 'username':'ServerBot', 'msg':text, 'date':new Date()};
        io.to(room).emit('newMessage', message);
    });
    logger.emit('newEvent', 'newBroadcastMessage', {'msg':text});
};

// ***************************************************************************
// Express routes
// ***************************************************************************

// Welcome message
app.get('/', function(req, res) {
    res.send(200, "Welcome to chat server");
});

// Broadcast message to all connected users
app.post('/api/broadcast/', requireAuthentication, function(req, res) {
    sendBroadcast(req.body.msg);
    res.send(201, "Message sent to all rooms");
}); 

// ***************************************************************************
// Socket.io events
// ***************************************************************************

io.sockets.on('connection', function(socket) {

    // Welcome message on connection
    socket.emit('connected', 'Welcome to the chat server');
    logger.emit('newEvent', 'userConnected', {'socket':socket.id});

    // Store user data in db
    db.hset([socket.id, 'connectionDate', new Date()], adapter.print);
    db.hset([socket.id, 'socketID', socket.id], adapter.print);
    db.hset([socket.id, 'username', 'anonymous'], adapter.print);

    // Join user to 'MainRoom'
    socket.join(conf.mainroom);
    logger.emit('newEvent', 'userJoinsRoom', {'socket':socket.id, 'room':conf.mainroom});
    // Confirm subscription to user
    socket.emit('subscriptionConfirmed', {'room':conf.mainroom});
    // Notify subscription to all users in room
    var data = {'room':conf.mainroom, 'username':'anonymous', 'msg':'----- Joined the room -----', 'id':socket.id};
    io.to(conf.mainroom).emit('userJoinsRoom', data);

    // User wants to subscribe to [data.rooms]
    socket.on('subscribe', function(data) {
        // Get user info from db
        db.hget([socket.id, 'username'], function(err, username) {

            // Subscribe user to chosen rooms
            _.each(data.rooms, function(room) {
                room = room.replace(" ","");
                socket.join(room);
                logger.emit('newEvent', 'userJoinsRoom', {'socket':socket.id, 'username':username, 'room':room});

                // Confirm subscription to user
                socket.emit('subscriptionConfirmed', {'room': room});
        
                // Notify subscription to all users in room
                if (socket.rooms.indexOf(room) >= 0)
                {
                    var message = { 'room': room, 'username': username, 'msg': '----- Already in the room -----', 'id': socket.id };
                } else {
                    var message = { 'room': room, 'username': username, 'msg': '----- Joined the room -----', 'id': socket.id };
                }
                io.to(room).emit('userJoinsRoom', message);
            });
        });
    });

    // User wants to unsubscribe from [data.rooms]
    socket.on('unsubscribe', function(data) {
        // Get user info from db
        db.hget([socket.id, 'username'], function(err, username) {
        
            // Unsubscribe user from chosen rooms
            _.each(data.rooms, function(room) {
                if (room != conf.mainroom) {
                    socket.leave(room);
                    logger.emit('newEvent', 'userLeavesRoom', {'socket':socket.id, 'username':username, 'room':room});
                
                    // Confirm unsubscription to user
                    socket.emit('unsubscriptionConfirmed', {'room': room});
        
                    // Notify unsubscription to all users in room
                    var message = {'room':room, 'username':username, 'msg':'----- Left the room -----', 'id': socket.id};
                    io.to(room).emit('userLeavesRoom', message);
                }
            });
        });
    });

    // User wants to know what rooms he has joined
    socket.on('getRooms', function(data) {
        socket.emit('roomsReceived', socket.rooms);
        logger.emit('newEvent', 'userGetsRooms', {'socket':socket.id});
    });

    // Get users in given room
    socket.on('getUsersInRoom', function(data) {
        var usersInRoom = [];
        var socketsInRoom = _.keys(io.nsps['/'].adapter.rooms[data.room]);
        for (var i=0; i<socketsInRoom.length; i++) {
            db.hgetall(socketsInRoom[i], function(err, obj) {
                usersInRoom.push({'room':data.room, 'username':obj.username, 'id':obj.socketID});
                // When we've finished with the last one, notify user
                if (usersInRoom.length == socketsInRoom.length) {
                    socket.emit('usersInRoom', {'users':usersInRoom});
                }
            });
        }
    });

    // Get userInfo
    socket.on('getUserInfo', function (data) {
        // Get user info from db
        db.hget([socket.id, 'username'], function (err, username) {
            socket.emit('userInfoReceived', { 'username': username });
        })
    });

    // User wants to change his nickname
    socket.on('setNickname', function(data) {
        // Get user info from db
        db.hget([socket.id, 'username'], function(err, username) {

            // Store user data in db
            db.hset([socket.id, 'username', data.username], adapter.print);
            logger.emit('newEvent', 'userSetsNickname', {'socket':socket.id, 'oldUsername':username, 'newUsername':data.username});

            // Notify all users who belong to the same rooms that this one
            _.each(socket.rooms, function(room) {
                if (room) {
                    var info = {'room':room, 'oldUsername':username, 'newUsername':data.username, 'id':socket.id};
                    io.to(room).emit('userNicknameUpdated', info);
                }
            });
        });
    });

    // New message sent to group
    socket.on('newMessage', function(data) {
        db.hgetall(socket.id, function(err, obj) {
            if (err) return logger.emit('newEvent', 'error', err);
            // Check if user is subscribed to room before sending his message
            if (_.contains(_.values(socket.rooms), data.room)) {
                var message = {'room':data.room, 'username':obj.username, 'msg':data.msg, 'date':new Date()};
                // Send message to room
                io.to(data.room).emit('newMessage', message);
                logger.emit('newEvent', 'newMessage', message);
            }
        });
    });

    // Clean up on disconnect
    socket.on('disconnect', function() {
        
        // Get current rooms of user
        var rooms = socket.rooms;
        
        // Get user info from db
        db.hgetall(socket.id, function(err, obj) {
            if (err) return logger.emit('newEvent', 'error', err);
            logger.emit('newEvent', 'userDisconnected', {'socket':socket.id, 'username':obj.username});

            // Notify all users who belong to the same rooms that this one
            _.each(rooms, function(room) {
                if (room) {
                    var message = {'room':room, 'username':obj.username, 'msg':'----- Left the room -----', 'id':obj.socketID};
                    io.to(room).emit('userLeavesRoom', message);
                }
            });
        });
    
        // Delete user from db
        db.del(socket.id, adapter.print);
    });
});

// Automatic message generation (for testing purposes)
if (conf.debug) {
    setInterval(function() {
        var text = 'Testing rooms';
        sendBroadcast(text);
    }, 60000);
}

