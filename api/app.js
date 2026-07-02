const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 7115;
const STATIC_DIR = path.join(__dirname, 'dist/duck-in-boots/browser');

app.use(express.static(STATIC_DIR));

app.get('*', (req, res) => {
  res.sendFile(path.join(STATIC_DIR, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Duck in Boots running on port ${PORT}`);
});
