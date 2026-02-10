## DROS Backend — Disaster Resource Optimization System

This backend provides a **self-contained, demo-stable** geospatial API for the DROS frontend:

- PostgreSQL 16 + PostGIS
- Node.js + Express + `pg`
- All data hardcoded / seeded for **Eastern India** (Odisha, Andhra Pradesh, Bay of Bengal coast)

It exposes:

- **GeoJSON** for maps (disasters, hospitals, resources, cell towers)
- **JSON** for optimization and dashboards

---

### 1. Windows Installation (Beginner-Friendly)

#### 1.1 Install / verify PostgreSQL 16

1. Download PostgreSQL 16 for Windows from the official site (Windows installer).
2. Run the installer:
   - Choose **PostgreSQL 16**.
   - Note your:
     - Username: usually `postgres`
     - Port: usually `5432`
     - Password: choose a strong one.
3. Verify from PowerShell:

```powershell
"$env:ProgramFiles\\PostgreSQL\\16\\bin"  # note path
& "$env:ProgramFiles\\PostgreSQL\\16\\bin\\psql.exe" --version
```

You should see something like `psql (PostgreSQL) 16.x`.

#### 1.2 Install PostGIS for PostgreSQL 16

If Stack Builder works:

1. Run **Stack Builder** (ships with PostgreSQL).
2. Select your PostgreSQL 16 instance.
3. Under **Spatial Extensions**, choose **PostGIS** for PostgreSQL 16.
4. Complete installation.

If Stack Builder freezes / fails (manual install):

1. Go to the PostGIS downloads page and download the **Windows installer** for PostGIS matching PostgreSQL 16.
2. Run the installer:
   - Target the PostgreSQL 16 installation directory when asked.
3. Restart PostgreSQL service if prompted.

#### 1.3 Verify PostGIS

Open PowerShell:

```powershell
& "$env:ProgramFiles\\PostgreSQL\\16\\bin\\psql.exe" -U postgres
```

In `psql`:

```sql
CREATE DATABASE dros;
\c dros;
CREATE EXTENSION postgis;
SELECT PostGIS_Version();
```

You should see a version string like `3.x.x` from `PostGIS_Version()`.

#### 1.4 Install DBeaver (optional but recommended)

1. Download **DBeaver Community** for Windows.
2. Install with default options.
3. Add a new connection:
   - Database: **PostgreSQL**
   - Host: `localhost`
   - Port: `5432`
   - Database: `dros`
   - User: `postgres`
   - Password: your password.
4. Test connection and save.

---

### 2. Create Schema + Seed Demo Data

From the project root (`DROS` folder):

```powershell
cd backend
& "$env:ProgramFiles\\PostgreSQL\\16\\bin\\psql.exe" -U postgres -d dros -f ".\\sql\\schema_and_seed.sql"
```

This will:

- Ensure `postgis` extension is enabled.
- Create tables:
  - `disasters`
  - `hospitals`
  - `resources`
  - `cell_towers`
- Seed:
  - 5 hospitals
  - 6 towers
  - 10 resource locations

You can verify quickly:

```powershell
& "$env:ProgramFiles\\PostgreSQL\\16\\bin\\psql.exe" -U postgres -d dros -c "SELECT COUNT(*) FROM hospitals;"
```

---

### 3. Configure Backend (Environment)

In `backend/`:

1. Copy the example env file:

```powershell
cd backend
Copy-Item .env.example .env
```

2. Edit `.env` and fill in your PostgreSQL credentials:

```env
PGHOST=localhost
PGPORT=5432
PGDATABASE=dros
PGUSER=postgres
PGPASSWORD=your_password_here
PORT=3001
```

Optionally you can set a `DATABASE_URL` instead.

---

### 4. Run the Backend

Install Node dependencies (already done once; repeat only if needed):

```powershell
cd backend
npm install
```

Start the server:

```powershell
npm start
```

You should see:

```text
[server] Listening on http://localhost:3001
```

Health check:

```powershell
curl http://localhost:3001/api/health
```

Expected JSON:

```json
{"ok":true,"service":"dros-backend","time":"..."}
```

---

### 5. API Overview (GeoJSON + JSON)

Base URL (by default):

- `http://localhost:3001/api`

#### 5.1 Disasters

- **GET** `/api/disasters`

Returns **GeoJSON**:

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "geometry": { "type": "Point", "coordinates": [85.8, 20.3] },
      "properties": {
        "id": 1,
        "type": "Cyclone",
        "severity": 4,
        "affected_radius": 120000,
        "evacuation_radius": 180000,
        "created_at": "..."
      }
    }
  ]
}
```

- **POST** `/api/disaster`

Body:

```json
{
  "type": "Cyclone",
  "severity": 4,
  "lat": 20.3,
  "lng": 85.9
}
```

Creates a disaster using the radius formula:

\[
radius = base + (max - base) \times (severity / 5)
\]

Returns the created Feature (GeoJSON).

#### 5.2 Hospitals

- **GET** `/api/hospitals`

Returns **GeoJSON** FeatureCollection with `name`, `capacity`.

#### 5.3 Resources

- **GET** `/api/resources`

Returns **GeoJSON** FeatureCollection with:

- `type`: `ambulance`, `rescue_teams`, `food`, `water`, `medical_kits`
- `quantity`

#### 5.4 Cell Towers + Alerts

- **GET** `/api/towers`

Returns **GeoJSON** FeatureCollection where each tower has:

- `coverage_radius` (meters)
- `disaster_id` (highest risk disaster affecting it, or `null`)
- `risk_level`: `HIGH`, `MID`, `LOW`, or `NONE`
- `message`: prebuilt broadcast text (all devices under the tower receive the same message)

This is intended for:

- Rendering tower coverage circles.
- Driving broadcast-style alerts.

#### 5.5 Optimization

- **POST** `/api/optimize`

Body (optional):

```json
{
  "disaster_id": 1
}
```

If `disaster_id` is omitted, the latest disaster is used.

Returns JSON:

```json
{
  "disaster_id": 1,
  "type": "Cyclone",
  "severity": 4,
  "population_estimate": 80000,
  "assigned_ambulances": 12,
  "nearest_hospital": "AIIMS Bhubaneswar",
  "estimated_response_time": 22,
  "lives_saved_estimate": 320,
  "allocations": [
    {
      "resource": "ambulance",
      "source_type": "hospital",
      "source_id": 1,
      "source_name": "AIIMS Bhubaneswar",
      "quantity": 6,
      "distance_km": 12.3,
      "mode": "road",
      "eta_min": 15
    }
  ]
}
```

**Heuristics (explainable):**

- Distances are **true geodesic** distances via `ST_Distance` on `GEOGRAPHY`.
- ETA:
  - Road: assume 50 km/h.
  - Air (fallback for long distances): 200 km/h.
- Demand per disaster:
  - Ambulances: `4 + severity * 4` (capped).
  - Rescue teams, food: scale with severity.
- Priorities:
  - Nearest viable sources first.
  - No double allocation; each depot has finite `quantity`.
  - Scarcity naturally increases ETA and reduces `lives_saved_estimate`.

---

### 6. Sample cURL / Postman Tests

Create a disaster (Odisha coast cyclone):

```powershell
curl -X POST http://localhost:3001/api/disaster `
  -H "Content-Type: application/json" `
  -d "{ \"type\": \"Cyclone\", \"severity\": 4, \"lat\": 19.8, \"lng\": 85.9 }"
```

Run optimization for the latest disaster:

```powershell
curl -X POST http://localhost:3001/api/optimize `
  -H "Content-Type: application/json" `
  -d "{}"
```

List hospitals (GeoJSON):

```powershell
curl http://localhost:3001/api/hospitals
```

List resources (GeoJSON):

```powershell
curl http://localhost:3001/api/resources
```

List towers with broadcast state:

```powershell
curl http://localhost:3001/api/towers
```

---

### 7. Frontend Wiring Notes

- For **map layers**, use the GeoJSON endpoints:
  - `/api/disasters`
  - `/api/hospitals`
  - `/api/resources`
  - `/api/towers`
- For **dashboard + optimization**, use:
  - `POST /api/disaster` when a user simulates a new incident.
  - `POST /api/optimize` to get allocations, ETAs, and lives-saved estimates.

All endpoints are **CORS-enabled**, so you can call them directly from the existing frontend running on `localhost` (e.g. `http://localhost:5173` or via `index.html` file).

