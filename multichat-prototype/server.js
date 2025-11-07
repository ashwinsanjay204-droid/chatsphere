const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Set up EJS as view engine
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));

// ==========================================
// DATA STRUCTURES FOR ROOM & USER MANAGEMENT
// ==========================================

/**
 * rooms: Stores room configurations and user data
 * Structure: {
 *   roomName: {
 *     code: "room-password",
 *     admin: "adminSocketId",
 *     pending: [{ socketId, username }],
 *     active: [{ socketId, username }]
 *   }
 * }
 */
const rooms = {};

/**
 * users: Maps socket IDs to user data
 * Structure: {
 *   socketId: { username, room, status: 'pending'|'active'|'admin' }
 * }
 */
const users = {};

// ==========================================
// ROUTES
// ==========================================

// Landing/Showcase page
app.get("/", (req, res) => {
  res.render("landing");
});

// Chat application page
app.get("/chat", (req, res) => {
  res.render("chat");
});

// ==========================================
// SOCKET.IO EVENT HANDLERS
// ==========================================

io.on("connection", (socket) => {
  console.log(`[CONNECTION] User connected: ${socket.id}`);

  /**
   * Event: createRoom
   * Admin creates a new room with a code
   */
  socket.on("createRoom", (data, ack) => {
    const { roomName, code } = data;

    if (!roomName || !code) {
      return ack({ success: false, message: "Room name and code required" });
    }

    // Check if room already exists
    if (rooms[roomName]) {
      return ack({ success: false, message: "Room already exists" });
    }

    // Create new room
    rooms[roomName] = {
      code: code,
      admin: socket.id,
      pending: [],
      active: []
    };

    // Mark this socket as admin
    users[socket.id] = {
      username: "Admin",
      room: roomName,
      status: "admin"
    };

    socket.join(roomName);
    socket.join(`${roomName}-admin`); // Admin-only room for notifications

    console.log(`[CREATE ROOM] Room "${roomName}" created by admin ${socket.id}`);
    ack({ success: true, message: "Room created successfully", roomName });
  });

  /**
   * Event: requestJoin
   * User requests to join a room
   */
  socket.on("requestJoin", (data, ack) => {
    const { username, roomName, code } = data;

    if (!username || !roomName || !code) {
      return ack({ success: false, message: "All fields are required" });
    }

    // Check if room exists
    if (!rooms[roomName]) {
      return ack({ success: false, message: "Room does not exist" });
    }

    // Verify room code
    if (rooms[roomName].code !== code) {
      return ack({ success: false, message: "Invalid room code" });
    }

    // Add user to pending list
    const pendingUser = { socketId: socket.id, username };
    rooms[roomName].pending.push(pendingUser);

    // Store user data
    users[socket.id] = {
      username,
      room: roomName,
      status: "pending"
    };

    console.log(`[JOIN REQUEST] ${username} (${socket.id}) requesting to join "${roomName}"`);

    // Notify admin about pending user
    io.to(`${roomName}-admin`).emit("pendingUser", {
      socketId: socket.id,
      username,
      roomName
    });

    // Send updated pending list to admin
    io.to(`${roomName}-admin`).emit("updateUserLists", {
      pending: rooms[roomName].pending,
      active: rooms[roomName].active
    });

    ack({ success: true, message: "Waiting for admin approval..." });
  });

  /**
   * Event: approveUser
   * Admin approves a pending user
   */
  socket.on("approveUser", (data, ack) => {
    const { userSocketId, roomName } = data;

    if (!rooms[roomName] || rooms[roomName].admin !== socket.id) {
      return ack({ success: false, message: "Unauthorized" });
    }

    // Find user in pending list
    const pendingIndex = rooms[roomName].pending.findIndex(
      u => u.socketId === userSocketId
    );

    if (pendingIndex === -1) {
      return ack({ success: false, message: "User not found in pending list" });
    }

    // Move user from pending to active
    const [approvedUser] = rooms[roomName].pending.splice(pendingIndex, 1);
    rooms[roomName].active.push(approvedUser);

    // Update user status
    if (users[userSocketId]) {
      users[userSocketId].status = "active";
    }

    // Add user to room
    const userSocket = io.sockets.sockets.get(userSocketId);
    if (userSocket) {
      userSocket.join(roomName);

      // Notify the approved user
      userSocket.emit("joinApproved", {
        roomName,
        message: "You have been approved to join the room!"
      });

      // Notify all users in the room
      io.to(roomName).emit("userJoined", {
        username: approvedUser.username,
        message: `${approvedUser.username} joined the room`
      });

      // Send updated user lists to admin
      io.to(`${roomName}-admin`).emit("updateUserLists", {
        pending: rooms[roomName].pending,
        active: rooms[roomName].active
      });
    }

    console.log(`[APPROVE] ${approvedUser.username} approved in "${roomName}"`);
    ack({ success: true, message: "User approved" });
  });

  /**
   * Event: rejectUser
   * Admin rejects a pending user
   */
  socket.on("rejectUser", (data, ack) => {
    const { userSocketId, roomName } = data;

    if (!rooms[roomName] || rooms[roomName].admin !== socket.id) {
      return ack({ success: false, message: "Unauthorized" });
    }

    // Find user in pending list
    const pendingIndex = rooms[roomName].pending.findIndex(
      u => u.socketId === userSocketId
    );

    if (pendingIndex === -1) {
      return ack({ success: false, message: "User not found" });
    }

    // Remove from pending
    const [rejectedUser] = rooms[roomName].pending.splice(pendingIndex, 1);

    // Notify the rejected user
    const userSocket = io.sockets.sockets.get(userSocketId);
    if (userSocket) {
      userSocket.emit("joinRejected", {
        roomName,
        message: "Your join request was denied by the admin"
      });
    }

    // Clean up user data
    delete users[userSocketId];

    // Send updated pending list to admin
    io.to(`${roomName}-admin`).emit("updateUserLists", {
      pending: rooms[roomName].pending,
      active: rooms[roomName].active
    });

    console.log(`[REJECT] ${rejectedUser.username} rejected from "${roomName}"`);
    ack({ success: true, message: "User rejected" });
  });

  /**
   * Event: removeUser
   * Admin removes an active user from the room
   */
  socket.on("removeUser", (data, ack) => {
    const { userSocketId, roomName } = data;

    if (!rooms[roomName] || rooms[roomName].admin !== socket.id) {
      return ack({ success: false, message: "Unauthorized" });
    }

    // Find user in active list
    const activeIndex = rooms[roomName].active.findIndex(
      u => u.socketId === userSocketId
    );

    if (activeIndex === -1) {
      return ack({ success: false, message: "User not found" });
    }

    // Remove from active list
    const [removedUser] = rooms[roomName].active.splice(activeIndex, 1);

    // Notify the removed user
    const userSocket = io.sockets.sockets.get(userSocketId);
    if (userSocket) {
      userSocket.leave(roomName);
      userSocket.emit("removedFromRoom", {
        roomName,
        message: "You have been removed from the room by the admin"
      });
    }

    // Notify all users in the room
    io.to(roomName).emit("userLeft", {
      username: removedUser.username,
      message: `${removedUser.username} was removed from the room`
    });

    // Clean up user data
    delete users[userSocketId];

    // Send updated active list to admin
    io.to(`${roomName}-admin`).emit("updateUserLists", {
      pending: rooms[roomName].pending,
      active: rooms[roomName].active
    });

    console.log(`[REMOVE] ${removedUser.username} removed from "${roomName}"`);
    ack({ success: true, message: "User removed" });
  });

  /**
   * Event: sendMessage
   * User sends a message to the room
   */
  socket.on("sendMessage", (data, ack) => {
    const { message, roomName } = data;
    const user = users[socket.id];

    if (!user || (user.status !== "active" && user.status !== "admin")) {
      return ack({ success: false, message: "You must be an active member to send messages" });
    }

    if (user.room !== roomName) {
      return ack({ success: false, message: "You are not in this room" });
    }

    // Broadcast message to all users in the room (including sender)
    // Send message to everyone *except* the sender
socket.to(roomName).emit("newMessage", {
  username: user.username,
  message,
  timestamp: new Date().toISOString(),
  isOwnMessage: false
});

// Send only to the sender
socket.emit("newMessage", {
  username: "You",
  message,
  timestamp: new Date().toISOString(),
  isOwnMessage: true
});


    console.log(`[MESSAGE] ${user.username} in "${roomName}": ${message}`);
    ack({ success: true });
  });

  /**
   * Event: getRoomInfo
   * Admin requests current room information
   */
  socket.on("getRoomInfo", (data, ack) => {
    const { roomName } = data;

    if (!rooms[roomName] || rooms[roomName].admin !== socket.id) {
      return ack({ success: false, message: "Unauthorized" });
    }

    ack({
      success: true,
      pending: rooms[roomName].pending,
      active: rooms[roomName].active
    });
  });

  /**
   * Event: disconnect
   * Handle user disconnection and cleanup
   */
  socket.on("disconnect", () => {
    const user = users[socket.id];

    if (!user) {
      console.log(`[DISCONNECT] Unknown user ${socket.id}`);
      return;
    }

    const { username, room, status } = user;

    console.log(`[DISCONNECT] ${username} (${socket.id}) disconnected from "${room}"`);

    // If admin disconnects, clean up the room
    if (status === "admin" && rooms[room]) {
      // Notify all users that room is closing
      io.to(room).emit("roomClosed", {
        message: "The room has been closed by the admin"
      });

      // Clean up all users in this room
      [...rooms[room].pending, ...rooms[room].active].forEach(u => {
        delete users[u.socketId];
      });

      delete rooms[room];
      console.log(`[CLEANUP] Room "${room}" deleted`);
    } 
    // If regular user disconnects
    else if (rooms[room]) {
      // Remove from pending list
      rooms[room].pending = rooms[room].pending.filter(
        u => u.socketId !== socket.id
      );

      // Remove from active list
      const activeIndex = rooms[room].active.findIndex(
        u => u.socketId === socket.id
      );

      if (activeIndex !== -1) {
        rooms[room].active.splice(activeIndex, 1);

        // Notify room that user left
        io.to(room).emit("userLeft", {
          username,
          message: `${username} left the room`
        });
      }

      // Update admin with new lists
      io.to(`${room}-admin`).emit("updateUserLists", {
        pending: rooms[room].pending,
        active: rooms[room].active
      });
    }

    // Clean up user data
    delete users[socket.id];
  });
});

// ==========================================
// SERVER STARTUP WITH PORT FALLBACK
// ==========================================

const DEFAULT_PORT = 7890;
const MAX_PORT_ATTEMPTS = 10;

/**
 * Attempts to start the server on the specified port
 * If the port is in use, tries the next port
 */
function startServer(port, attempt = 1) {
  if (attempt > MAX_PORT_ATTEMPTS) {
    console.error(`[ERROR] Could not find an available port after ${MAX_PORT_ATTEMPTS} attempts`);
    process.exit(1);
  }

  server.listen(port)
    .on("listening", () => {
      console.log(`
╔════════════════════════════════════════════════════════╗
║                                                        ║
║        🚀 ChatSphere Server Running!                  ║
║                                                        ║
║        Landing Page: http://localhost:${port}         ║
║        Chat App: http://localhost:${port}/chat        ║
║                                                        ║
║        Press Ctrl+C to stop                           ║
║                                                        ║
╚════════════════════════════════════════════════════════╝
      `);
    })
    .on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        console.log(`[WARNING] Port ${port} is in use, trying port ${port + 1}...`);
        startServer(port + 1, attempt + 1);
      } else {
        console.error(`[ERROR] Server error:`, err);
        process.exit(1);
      }
    });
}

// Start the server
startServer(process.env.PORT || DEFAULT_PORT);

// ==========================================
// GRACEFUL SHUTDOWN
// ==========================================

process.on("SIGINT", () => {
  console.log("\n[SHUTDOWN] Closing server gracefully...");
  server.close(() => {
    console.log("[SHUTDOWN] Server closed");
    process.exit(0);
  });
});