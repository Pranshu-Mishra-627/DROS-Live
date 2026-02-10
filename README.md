# DROS - Disaster Resource Optimization System

A comprehensive disaster response decision and communication system for incident command authorities.

## 🚀 Quick Start

### Local Development

1. **Setup Database:**
   ```bash
   # Install PostgreSQL 16 + PostGIS
   # Run schema_and_seed.sql in your database
   ```

2. **Backend:**
   ```bash
   cd backend
   npm install
   cp .env.example .env
   # Edit .env with your database credentials
   npm start
   ```

3. **Frontend:**
   ```bash
   cd frontend
   # Open index.html in browser, or use a local server:
   npx serve .
   ```

## 📦 Deployment

### Deploy to GitHub Pages

See [GITHUB_DEPLOYMENT.md](./GITHUB_DEPLOYMENT.md) for complete instructions.

**Quick steps:**
1. Push code to GitHub
2. Enable GitHub Pages in repo settings
3. Deploy backend to Railway/Render
4. Update API URL in `frontend/index.html`

**Live Demo:** [Your GitHub Pages URL]

## 🏗️ Architecture

- **Frontend:** HTML5, CSS3, JavaScript (ES6+), Leaflet.js
- **Backend:** Node.js, Express.js, PostgreSQL, PostGIS
- **SMS:** Twilio (optional)

## 📁 Project Structure

```
DROS/
├── frontend/          # Static frontend files
│   ├── index.html
│   ├── style.css
│   └── app.js
├── backend/           # Node.js backend
│   ├── server.js
│   ├── routes/
│   ├── sql/
│   └── utils/
└── .github/          # GitHub Actions workflows
```

## 🔧 Configuration

### Environment Variables

**Backend (`backend/.env`):**
- `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`
- `PORT=3001`
- `SMS_ENABLED=false`
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`

**Frontend:**
- Update `window.DROS_API_BASE` in `index.html` for production

## 📝 Features

- Interactive disaster management map
- Real-time resource optimization
- Multi-disaster support
- Risk zone visualization (High/Medium/Low)
- Emergency communication alerts (SMS via Twilio)
- Hospital and resource allocation
- Population impact estimation

## 📄 License

ISC

## 👤 Author

Your Name
