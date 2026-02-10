# Deploy DROS to GitHub Pages + Backend Service

## Step-by-Step Guide

### Part 1: Prepare Your Repository

1. **Initialize Git (if not done):**
   ```bash
   cd C:\Users\Amogh\Desktop\projects\DROS
   git init
   git add .
   git commit -m "Initial commit"
   ```

2. **Create GitHub Repository:**
   - Go to https://github.com/new
   - Repository name: `DROS` (or any name)
   - Make it **Public** (required for free GitHub Pages)
   - Click "Create repository"

3. **Push to GitHub:**
   ```bash
   git remote add origin https://github.com/YOUR_USERNAME/DROS.git
   git branch -M main
   git push -u origin main
   ```

---

### Part 2: Deploy Frontend to GitHub Pages

#### Option A: Automatic Deployment (Recommended)

1. **Enable GitHub Pages:**
   - Go to your repo → **Settings** → **Pages**
   - Source: **GitHub Actions**
   - Save

2. **The workflow will auto-deploy** when you push changes to `frontend/`

3. **Your site will be live at:**
   ```
   https://YOUR_USERNAME.github.io/DROS/
   ```

#### Option B: Manual Setup

1. Go to repo → **Settings** → **Pages**
2. Source: **Deploy from a branch**
3. Branch: `main`
4. Folder: `/frontend`
5. Click **Save**

---

### Part 3: Deploy Backend (Choose One)

**⚠️ Important:** GitHub Pages only hosts static files. Your backend needs a separate service.

#### Option 1: Railway (Easiest - Free Tier)

1. **Sign up:** https://railway.app (use GitHub login)

2. **Create New Project:**
   - Click "New Project"
   - Select "Deploy from GitHub repo"
   - Choose your DROS repository

3. **Add Service:**
   - Click "New" → "GitHub Repo"
   - Select your repo
   - **Root Directory:** `backend`
   - Railway auto-detects Node.js

4. **Set Environment Variables:**
   - Go to your service → **Variables**
   - Add all variables from `backend/.env`:
     ```
     PGHOST=...
     PGPORT=5432
     PGDATABASE=...
     PGUSER=...
     PGPASSWORD=...
     PORT=3001
     SMS_ENABLED=false
     TWILIO_ACCOUNT_SID=...
     TWILIO_AUTH_TOKEN=...
     TWILIO_FROM_NUMBER=...
     ```

5. **Add PostgreSQL Database:**
   - Click "New" → "Database" → "PostgreSQL"
   - Railway creates database automatically
   - Copy the `DATABASE_URL` and add to Variables

6. **Run Database Migrations:**
   - Go to your PostgreSQL service → **Connect**
   - Use Railway's built-in terminal or DBeaver
   - Run `backend/sql/schema_and_seed.sql`

7. **Get Backend URL:**
   - Railway gives you a URL like: `https://dros-backend-production.up.railway.app`
   - Copy this URL

#### Option 2: Render (Free Tier)

1. **Sign up:** https://render.com (use GitHub login)

2. **Create New Web Service:**
   - Connect your GitHub repo
   - **Name:** `dros-backend`
   - **Root Directory:** `backend`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`

3. **Set Environment Variables** (same as Railway)

4. **Add PostgreSQL:**
   - Create new PostgreSQL database
   - Copy connection string to `DATABASE_URL`

5. **Deploy** - Render auto-deploys on push

#### Option 3: Fly.io (Free Tier)

1. **Install Fly CLI:**
   ```bash
   powershell -Command "iwr https://fly.io/install.ps1 -useb | iex"
   ```

2. **Login:**
   ```bash
   fly auth login
   ```

3. **Create app:**
   ```bash
   cd backend
   fly launch
   ```

4. **Set secrets:**
   ```bash
   fly secrets set PGHOST=... PGPASSWORD=... etc
   ```

---

### Part 4: Update Frontend API URL

1. **Update `frontend/index.html`:**
   ```html
   <script>
     // Use environment variable or fallback to production backend
     window.DROS_API_BASE = "https://your-backend-url.railway.app/api";
   </script>
   ```

2. **OR make it configurable:**
   ```html
   <script>
     // Auto-detect: production backend if on GitHub Pages, localhost if local
     const isProduction = window.location.hostname !== 'localhost' && 
                          window.location.hostname !== '127.0.0.1';
     window.DROS_API_BASE = isProduction 
       ? "https://your-backend-url.railway.app/api"
       : "http://localhost:3001/api";
   </script>
   ```

3. **Commit and push:**
   ```bash
   git add frontend/index.html
   git commit -m "Update API URL for production"
   git push
   ```

---

### Part 5: Final Steps

1. **Wait for GitHub Pages to deploy** (~2 minutes)
2. **Visit your live site:**
   ```
   https://YOUR_USERNAME.github.io/DROS/
   ```

3. **Test:**
   - Open browser console (F12)
   - Check for API connection
   - Test creating disasters
   - Test optimization

---

## Quick Reference

### Your URLs:
- **Frontend:** `https://YOUR_USERNAME.github.io/DROS/`
- **Backend:** `https://your-backend.railway.app` (or Render/Fly.io)

### Update API URL:
Edit `frontend/index.html` line ~128:
```javascript
window.DROS_API_BASE = "https://your-backend-url/api";
```

### Database Setup:
1. Create PostgreSQL on Railway/Render
2. Run `backend/sql/schema_and_seed.sql`
3. Update `DATABASE_URL` in backend environment variables

---

## Troubleshooting

**Frontend shows but API calls fail:**
- Check browser console for CORS errors
- Verify backend URL in `index.html` is correct
- Make sure backend has `cors()` enabled (already done)

**Backend deployment fails:**
- Check environment variables are set
- Verify `package.json` has correct start script
- Check Railway/Render logs

**Database connection fails:**
- Verify `DATABASE_URL` or PostgreSQL vars are set
- Check database is running
- Run migrations: `backend/sql/schema_and_seed.sql`

---

## Recommended Setup

**Easiest path:**
1. ✅ GitHub Pages for frontend (automatic)
2. ✅ Railway for backend (easiest setup)
3. ✅ Railway PostgreSQL (integrated)

**Total time:** ~15 minutes
