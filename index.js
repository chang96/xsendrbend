//using chartlesstv@gmail.com on heroku
const express = require("express");
const app = express();
const http = require("http").Server(app);
const io = require("socket.io")(http);
const PORT = process.env.PORT || 3009;
const cors = require("cors");
const path = require("path");
const fs = require("fs");
app.use(cors());

const statsFilePath = path.join(__dirname, "stats.json");
let completedTransfersCount = 0;
let totalBytesTransferred = 0;
let lastUpdated = null;
const activeFileSizes = new Map();

try {
    if (fs.existsSync(statsFilePath)) {
        const rawData = fs.readFileSync(statsFilePath);
        const stats = JSON.parse(rawData);
        completedTransfersCount = stats.completedTransfers || 0;
        totalBytesTransferred = stats.totalBytesTransferred || 0;
        lastUpdated = stats.lastUpdated || null;
    } else {
        lastUpdated = new Date().toISOString();
        fs.writeFileSync(statsFilePath, JSON.stringify({
            completedTransfers: 0,
            totalBytesTransferred: 0,
            lastUpdated: lastUpdated
        }, null, 2));
    }
} catch (err) {
    console.error("Error reading stats.json:", err);
}

function updateStats(additionalBytes, isCompletedTransfer = false) {
    if (isCompletedTransfer) {
        completedTransfersCount++;
    }
    if (additionalBytes > 0) {
        totalBytesTransferred += additionalBytes;
    }
    lastUpdated = new Date().toISOString();

    try {
        fs.writeFileSync(statsFilePath, JSON.stringify({
            completedTransfers: completedTransfersCount,
            totalBytesTransferred: totalBytesTransferred,
            lastUpdated: lastUpdated
        }, null, 2));
    } catch (err) {
        console.error("Error writing to stats.json:", err);
    }
}

function generateRoomId(length = 4) {
    const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let result = "";
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

app.get("/", (req, res)=> {
    let room = req.query.room || "xyz"
    res.send("running")
})

app.get("/transfers-count", (req, res) => {
    res.json({
        completedTransfers: completedTransfersCount,
        totalBytesTransferred: totalBytesTransferred,
        lastUpdated: lastUpdated
    });
});

const getRoomCount = (roomName) => {
    const clients = io.sockets.adapter.rooms.get(roomName);
    return clients ? clients.size : 0;
};

io.on("connection", function(socket){
    socket.on("createRoom", function(data){
        if(data.room){
            let newRoom = generateRoomId(4)
            socket.join(newRoom)
            
            const count = getRoomCount(newRoom);
            io.to(newRoom).emit("room-members-count", { count: count });
            
            socket.emit("newRoomis", newRoom)
        }
    })

    socket.on("joinRoom", function(data){
        let roomName = String(data.roomName).toUpperCase()
        socket.join(roomName)
        
        const count = getRoomCount(roomName);
        io.to(roomName).emit("room-members-count", { count: count });
        
        socket.to(roomName).emit("joinedRoom", {room : roomName})
        socket.emit("joinedRoom", {room : roomName})
    })

    socket.on("disconnecting", () => {
        for (const room of socket.rooms) {
            if (room !== socket.id) {
                const count = getRoomCount(room);
                socket.to(room).emit("room-members-count", { count: Math.max(0, count - 1) });
            }
        }
    });

    socket.on("messageFromClient", function(data){
        // console.log(data)
        let textLength = 0;
        if (data.message && typeof data.message === "string") {
            textLength = Buffer.byteLength(data.message, 'utf8');
        } else if (data.text && typeof data.text === "string") {
            textLength = Buffer.byteLength(data.text, 'utf8');
        }
        if (textLength > 0) {
            updateStats(textLength, false);
        }
        socket.to(data.roomName).emit("messageFromServer", data)
    })

    // Stateless Binary Relay Events
    socket.on("file-meta-relay", function(data){
        if (data.fileId && typeof data.size === "number") {
            activeFileSizes.set(data.fileId, data.size);
        }
        socket.to(data.roomName).emit("messageFromServer", {
            xtype: "file-meta",
            fileId: data.fileId,
            name: data.name,
            size: data.size,
            type: data.type,
            totalChunks: data.totalChunks,
            noteId: data.noteId
        });
    });

    socket.on("file-chunk-relay", function(data){
        socket.to(data.roomName).emit("file-chunk-received", {
            fileId: data.fileId,
            index: data.index,
            chunk: data.chunk
        });
    });

    socket.on("file-done-relay", function(data){
        let size = 0;
        if (data.fileId && activeFileSizes.has(data.fileId)) {
            size = activeFileSizes.get(data.fileId);
            activeFileSizes.delete(data.fileId);
        }
        updateStats(size, true);
        socket.to(data.roomName).emit("messageFromServer", {
            xtype: "file-done",
            fileId: data.fileId
        });
    });

    socket.on("file-chunk-ack", function(data){
        socket.to(data.roomName).emit("file-chunk-ack-received", {
            fileId: data.fileId,
            index: data.index
        });
    });
    socket.on("file-resume-request", function(data){
        socket.to(data.roomName).emit("file-resume-request-received", {
            fileId: data.fileId
        });
    });

    socket.on("file-resume-response", function(data){
        socket.to(data.roomName).emit("file-resume-response-received", {
            fileId: data.fileId,
            nextIndex: data.nextIndex
        });
    });

    socket.on("ping-server", function(){
        socket.emit("pong-client");
    });

    socket.on("iceCandidate", function(data){
        socket.to(data.room).emit("iceCandidateReceived", data)
    })

    socket.on("offer", function(data){
        socket.to(data.room).emit("offerSent", data)
    })
    socket.on("offerReceived", function(data){
        socket.to(data.room).emit("answerSent", data)
    })

})


http.listen(PORT, function(PORT){
    console.log("running..."+PORT)
})