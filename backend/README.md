# Backend (Flask)

The frontend calls the backend from the browser at `http://127.0.0.1:5000`.
GitHub Pages cannot reach `127.0.0.1`, so gas prices will only work locally.

## Run
### Windows (recommended)
- Double-click `start.bat` in the project root.

### Manual
```bash
pip install -r requirements.txt
python app.py
```

## Endpoints
- `GET /api/health` -> `{ ok: true }`
- `GET /api/gas-prices?zip=#####&lat=...&lng=...`

