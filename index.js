//using chartlesstv@gmail.com on heroku
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
const fs = require("fs")
app.use(cors());
function rep(str){
    let splited = str.split("")
    let res = splited.map(x=>{
        if(x=== "_" || x==="-"){
            return "a"
        } else {
            return x
        }
    })

    return res.join("")

}

app.get("/", (req, res)=> {
    let room = req.query.room || "xyz"
    res.send("running")
})

io.on("connection", function(socket){
    socket.on("createRoom", function(data){
        if(data.room){
            let newRoom = nano(4)
            socket.join(rep(newRoom))
            socket.emit("newRoomis", newRoom)
        }
    })

    socket.on("joinRoom", function(data){
        // console.log(data)
        let roomName = data.roomName
        socket.join(roomName)
        // console.log(roomName)
        socket.to(roomName).emit("joinedRoom", {room : roomName})
        socket.emit("joinedRoom", {room : roomName})
    })

    socket.on("messageFromClient", function(data){
        // console.log(data)
        socket.to(data.roomName).emit("messageFromServer", data)
    })
    ss(socket).on("file", function(roomName, data){
        console.log("data",data, roomName)
       
    })

    socket.on("offer", function(data){
        socket.to(data.room).emit("offerSent", data)
    })
    socket.on("offerReceived", function(data){
        socket.to(data.room).emit("answerSent", data)
    })

})


http.listen(PORT, function(PORT){
    console.log("running...")
})