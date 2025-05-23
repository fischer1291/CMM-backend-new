const express = require("express");
const mongoose = require("mongoose");
const dotenv = require("dotenv");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// Middlewares
app.use(cors());
app.use(express.json());

// MongoDB verbinden
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ MongoDB verbunden"))
  .catch((err) => console.error("❌ Fehler bei MongoDB:", err));

// Routen einbinden
app.use("/auth", require("./routes/auth"));
app.use("/contacts", require("./routes/contacts"));
app.use("/status", require("./routes/status")(io)); // io wird übergeben
app.use("/verify", require("./routes/verify"));

// WebSocket Listener
io.on("connection", (socket) => {
  console.log("🔌 WebSocket verbunden:", socket.id);
});

// Start
const PORT = 3000;
server.listen(PORT, () =>
  console.log(`🚀 Server läuft mit WebSocket auf Port ${PORT}`),
);
