const mongoose = require("mongoose");

// A recurring person in the hero videos (Anna, Lena, …). Who they are is
// written in the CMM repo (marketing/agent/characters.js); here live the
// reference images: candidates from the image model and the one a person
// chose in the console. Veo gets the chosen one, so the face stays the same.
const imageSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    publicId: { type: String, default: null },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const marketingCharacterSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  summary: { type: String, default: "" },
  candidates: { type: [imageSchema], default: [] },
  chosen: { type: imageSchema, default: null },
  // "New suggestions" in the console, with what should change
  wantsNew: { type: Boolean, default: false },
  feedback: { type: String, default: null },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("MarketingCharacter", marketingCharacterSchema);
