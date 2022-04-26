const express = require("express");
const app = express()
const http = require("http").Server(app)
const io = require("socket.io")(http)
const PORT = process.env.PORT || 3001
const ids = ["0xe8", "0xg7de", "0xhs8"]
const cors = require("cors")
const nano = require("nanoid")
const path = require("path")
const ss = require("socket.io-stream")
app.use(cors())
// app.get("/", (req, res)=> {

// })

app.get("/", (req, res)=> {
    let room = req.query.room || "xyz"
    console.log(room)
    res.send("running")
})

io.on("connection", function(socket){
    socket.on("createRoom", function(data){
        if(data.room){
            let newRoom = nano(4)
            socket.join(newRoom)
            socket.emit("newRoomis", newRoom)
        }
    })

    socket.on("joinRoom", function(data){
        console.log(data)
        let roomName = data.roomName
        socket.join(roomName)
        socket.to(roomName).emit("joinedRoom", {room : roomName})
        socket.emit("joinedRoom", {room : roomName})
    })

    socket.on("messageFromClient", function(data){
        console.log(data)
        socket.to(data.roomName).emit("messageFromServer", data)
    })
    ss(socket).on("file", function(stream, data){
        let filename = path.basename(data.name)
        stream.pipe(fs.createWriteStream(filename))
    })
})

// let createdRoom = io.of("/createroom")
// createdRoom.on("connection", function(socket){
//     let room = nano(4)
//     console.log(room)
//     socket.join(room)

//     createdRoom.in(room).emit("connectToRoom", `you are connected to ${room}`)
// })

// let joinRoom = io.of("/joinroom")
// joinRoom.on("connection", function(socket){
    
//     socket.on("room", function(data){
//         console.log(data)
//         socket.join(data)
//         socket.broadcast.emit("connectToRoom", `you are c to ${data}`)
//     })
// })

http.listen(PORT, function(PORT){
    console.log("running...")
})