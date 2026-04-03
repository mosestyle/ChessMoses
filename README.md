# Chess Analysis Lite
https://mosestyle.github.io/ChessMoses/

Small, mobile-friendly chess analysis app for GitHub Pages.

## Features
- Paste PGN and generate a move-by-move report
- Paste FEN and analyze the current position
- Labels: Theory, Best, Excellent, Good, Okay, Inaccuracy, Mistake, Blunder, Critical, Brilliant
- Responsive layout for phone and desktop
- Browser Stockfish, so no backend is required

## Stack
- React + Vite
- chess.js
- react-chessboard
- stockfish.js

## Run
```bash
npm install
npm run dev
```

## Build
```bash
npm run build
```

## Note
This starter stays intentionally small. The opening/theory list is slim by design instead of bundling a giant ECO dataset.
