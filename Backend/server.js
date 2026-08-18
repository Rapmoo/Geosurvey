/* ===================================================================
   server.js
   ---------------------------------------------------------------
   Entry point. `npm start` runs this. Separate from app.js so app.js
   can be required in tests without opening a real port.
   =================================================================== */
console.log("server.js loaded");   
const app = require('./app');

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log(`GeoSurvey file storage API listening on port ${PORT}`);
});
