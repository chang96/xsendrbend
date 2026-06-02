//using chartlesstv@gmail.com on heroku
const express = require("express");
const app = express();
const http = require("http").Server(app);
const io = require("socket.io")(http);
const PORT = process.env.PORT || 3009;
const cors = require("cors");
const path = require("path");
app.use(cors());

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

io.on("connection", function(socket){
    socket.on("createRoom", function(data){
        if(data.room){
            let newRoom = generateRoomId(4)
            socket.join(newRoom)
            socket.emit("newRoomis", newRoom)
        }
    })

    socket.on("joinRoom", function(data){
        let roomName = String(data.roomName).toUpperCase()
        socket.join(roomName)
        socket.to(roomName).emit("joinedRoom", {room : roomName})
        socket.emit("joinedRoom", {room : roomName})
    })

    socket.on("messageFromClient", function(data){
        // console.log(data)
        socket.to(data.roomName).emit("messageFromServer", data)
    })

    // Stateless Binary Relay Events
    socket.on("file-meta-relay", function(data){
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