-- DROS (Disaster Resource Optimization System)
-- PostgreSQL + PostGIS schema and seed data (Eastern India demo)
--
-- Usage (psql):
--   psql -U postgres -d dros -f backend/sql/schema_and_seed.sql

BEGIN;

CREATE EXTENSION IF NOT EXISTS postgis;

-- ---------- Tables ----------
CREATE TABLE IF NOT EXISTS disasters (
  id SERIAL PRIMARY KEY,
  type TEXT NOT NULL,
  severity INT NOT NULL CHECK (severity BETWEEN 1 AND 5),
  location GEOGRAPHY(Point, 4326) NOT NULL,
  affected_radius FLOAT NOT NULL,     -- meters
  evacuation_radius FLOAT NOT NULL,   -- meters
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hospitals (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  capacity INT NOT NULL,
  ambulances INT NOT NULL DEFAULT 0,
  location GEOGRAPHY(Point, 4326) NOT NULL
);

CREATE TABLE IF NOT EXISTS resources (
  id SERIAL PRIMARY KEY,
  type TEXT NOT NULL,
  quantity INT NOT NULL,
  location GEOGRAPHY(Point, 4326) NOT NULL
);

CREATE TABLE IF NOT EXISTS cell_towers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  location GEOGRAPHY(Point, 4326) NOT NULL,
  coverage_radius FLOAT NOT NULL   -- meters
);

-- Population data (land areas only, Eastern India)
CREATE TABLE IF NOT EXISTS population_zones (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  population INT NOT NULL,
  boundary GEOGRAPHY(Polygon, 4326) NOT NULL
);

-- Helpful indexes
CREATE INDEX IF NOT EXISTS idx_disasters_location ON disasters USING GIST (location);
CREATE INDEX IF NOT EXISTS idx_hospitals_location ON hospitals USING GIST (location);
CREATE INDEX IF NOT EXISTS idx_resources_location ON resources USING GIST (location);
CREATE INDEX IF NOT EXISTS idx_towers_location ON cell_towers USING GIST (location);
CREATE INDEX IF NOT EXISTS idx_population_boundary ON population_zones USING GIST (boundary);

-- Ensure ambulances column exists (for existing DBs)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='hospitals' AND column_name='ambulances') THEN
    ALTER TABLE hospitals ADD COLUMN ambulances INT NOT NULL DEFAULT 0;
  END IF;
END $$;

-- ---------- Seed data (idempotent-ish) ----------
TRUNCATE TABLE disasters RESTART IDENTITY;
TRUNCATE TABLE hospitals RESTART IDENTITY;
TRUNCATE TABLE resources RESTART IDENTITY;
TRUNCATE TABLE cell_towers RESTART IDENTITY;
TRUNCATE TABLE population_zones RESTART IDENTITY;

-- 20+ hospitals, total >= 2500 beds, each with ambulances (India mainland only)
INSERT INTO hospitals (name, capacity, ambulances, location) VALUES
  ('AIIMS Bhubaneswar', 180, 18, ST_SetSRID(ST_MakePoint(85.8245, 20.2961), 4326)::geography),
  ('SCB Medical College, Cuttack', 150, 15, ST_SetSRID(ST_MakePoint(85.8828, 20.4625), 4326)::geography),
  ('MKCG Medical College, Berhampur', 140, 12, ST_SetSRID(ST_MakePoint(84.7941, 19.3150), 4326)::geography),
  ('King George Hospital, Visakhapatnam', 220, 22, ST_SetSRID(ST_MakePoint(83.2977, 17.7041), 4326)::geography),
  ('Guntur Government Hospital', 130, 10, ST_SetSRID(ST_MakePoint(80.4365, 16.3067), 4326)::geography),
  ('Puri District Hospital', 120, 10, ST_SetSRID(ST_MakePoint(85.8317, 19.8135), 4326)::geography),
  ('Balasore District Hospital', 125, 10, ST_SetSRID(ST_MakePoint(86.9250, 21.4944), 4326)::geography),
  ('Rourkela Government Hospital', 160, 14, ST_SetSRID(ST_MakePoint(84.8544, 22.2604), 4326)::geography),
  ('Sambalpur Medical College', 135, 12, ST_SetSRID(ST_MakePoint(84.0067, 21.4700), 4326)::geography),
  ('Koraput District Hospital', 95, 8, ST_SetSRID(ST_MakePoint(82.7167, 18.8167), 4326)::geography),
  ('Vizianagaram District Hospital', 115, 10, ST_SetSRID(ST_MakePoint(83.4000, 18.1167), 4326)::geography),
  ('Rajahmundry Government Hospital', 145, 12, ST_SetSRID(ST_MakePoint(81.7833, 17.0000), 4326)::geography),
  ('Nellore District Hospital', 125, 10, ST_SetSRID(ST_MakePoint(79.9833, 14.4500), 4326)::geography),
  ('Ongole Government Hospital', 110, 8, ST_SetSRID(ST_MakePoint(80.0500, 15.5000), 4326)::geography),
  ('Kakinada District Hospital', 130, 11, ST_SetSRID(ST_MakePoint(82.2475, 16.9891), 4326)::geography),
  ('Bhadrak District Hospital', 90, 7, ST_SetSRID(ST_MakePoint(86.5167, 21.0500), 4326)::geography),
  ('Jeypore District Hospital', 85, 6, ST_SetSRID(ST_MakePoint(82.5833, 18.8500), 4326)::geography),
  ('Srikakulam Government Hospital', 100, 8, ST_SetSRID(ST_MakePoint(83.9000, 18.3000), 4326)::geography),
  ('Eluru District Hospital', 95, 7, ST_SetSRID(ST_MakePoint(81.1000, 16.7000), 4326)::geography),
  ('Kurnool Government Hospital', 140, 11, ST_SetSRID(ST_MakePoint(78.0500, 15.8333), 4326)::geography),
  ('Tirupati Government Hospital', 155, 12, ST_SetSRID(ST_MakePoint(79.4167, 13.6500), 4326)::geography);

-- 6 cell towers (coverage radii tuned for readability)
INSERT INTO cell_towers (name, location, coverage_radius) VALUES
  ('Tower — Bhubaneswar Central', ST_SetSRID(ST_MakePoint(85.8245, 20.2961), 4326)::geography, 18000),
  ('Tower — Cuttack',            ST_SetSRID(ST_MakePoint(85.8828, 20.4625), 4326)::geography, 20000),
  ('Tower — Puri Coast',         ST_SetSRID(ST_MakePoint(85.8317, 19.8135), 4326)::geography, 24000),
  ('Tower — Gopalpur Coast',     ST_SetSRID(ST_MakePoint(84.9167, 19.2667), 4326)::geography, 26000),
  ('Tower — Visakhapatnam',      ST_SetSRID(ST_MakePoint(83.2185, 17.6868), 4326)::geography, 22000),
  ('Tower — Kakinada Coast',     ST_SetSRID(ST_MakePoint(82.2475, 16.9891), 4326)::geography, 24000);

-- 25+ resource locations (no coincident points with hospitals or each other)
INSERT INTO resources (type, quantity, location) VALUES
  -- Ambulances (depots near but not on hospitals)
  ('ambulance', 12, ST_SetSRID(ST_MakePoint(85.8180, 20.3020), 4326)::geography),
  ('ambulance', 10, ST_SetSRID(ST_MakePoint(85.8880, 20.4580), 4326)::geography),
  ('ambulance', 14, ST_SetSRID(ST_MakePoint(83.2920, 17.7100), 4326)::geography),
  ('ambulance', 8, ST_SetSRID(ST_MakePoint(85.8260, 19.8080), 4326)::geography),
  ('ambulance', 9, ST_SetSRID(ST_MakePoint(86.9180, 21.5000), 4326)::geography),

  -- Rescue teams
  ('rescue_teams', 4, ST_SetSRID(ST_MakePoint(85.81, 20.30), 4326)::geography),
  ('rescue_teams', 3, ST_SetSRID(ST_MakePoint(84.91, 19.28), 4326)::geography),
  ('rescue_teams', 5, ST_SetSRID(ST_MakePoint(83.22, 17.69), 4326)::geography),
  ('rescue_teams', 3, ST_SetSRID(ST_MakePoint(84.8480, 22.2550), 4326)::geography),
  ('rescue_teams', 2, ST_SetSRID(ST_MakePoint(82.7220, 18.8050), 4326)::geography),

  -- Food supplies (unique locations)
  ('food', 6500, ST_SetSRID(ST_MakePoint(85.74, 20.26), 4326)::geography),
  ('food', 4800, ST_SetSRID(ST_MakePoint(83.31, 17.74), 4326)::geography),
  ('food', 5500, ST_SetSRID(ST_MakePoint(85.92, 20.43), 4326)::geography),
  ('food', 4200, ST_SetSRID(ST_MakePoint(84.01, 21.46), 4326)::geography),
  ('food', 3800, ST_SetSRID(ST_MakePoint(81.79, 16.98), 4326)::geography),
  ('food', 5000, ST_SetSRID(ST_MakePoint(79.99, 14.44), 4326)::geography),

  -- Water supplies (unique, not on hospital/food points)
  ('water', 12000, ST_SetSRID(ST_MakePoint(85.88, 20.48), 4326)::geography),
  ('water', 15000, ST_SetSRID(ST_MakePoint(85.72, 20.27), 4326)::geography),
  ('water', 10000, ST_SetSRID(ST_MakePoint(83.28, 17.75), 4326)::geography),
  ('water', 11000, ST_SetSRID(ST_MakePoint(83.98, 21.48), 4326)::geography),
  ('water', 9000, ST_SetSRID(ST_MakePoint(81.76, 17.02), 4326)::geography),

  -- Medical kits
  ('medical_kits', 260, ST_SetSRID(ST_MakePoint(80.44, 16.31), 4326)::geography),
  ('medical_kits', 200, ST_SetSRID(ST_MakePoint(85.80, 20.32), 4326)::geography),
  ('medical_kits', 180, ST_SetSRID(ST_MakePoint(83.32, 17.71), 4326)::geography),

  -- Helicopters (unique locations)
  ('helicopters', 3, ST_SetSRID(ST_MakePoint(85.79, 20.31), 4326)::geography),
  ('helicopters', 2, ST_SetSRID(ST_MakePoint(83.28, 17.70), 4326)::geography),
  ('helicopters', 2, ST_SetSRID(ST_MakePoint(84.84, 22.27), 4326)::geography);

-- Population zones (land areas only, Eastern India coastal and inland regions)
-- Using simplified rectangular polygons for demo (real system would use actual administrative boundaries)
-- INSERT INTO population_zones (name, population, boundary) VALUES
--   ('Bhubaneswar-Cuttack Region', 2500000, ST_SetSRID(ST_MakeEnvelope(85.5, 20.0, 86.2, 20.6, 4326)::geography)),
--   ('Puri Coastal Region', 800000, ST_SetSRID(ST_MakeEnvelope(85.6, 19.6, 86.0, 20.0, 4326)::geography)),
--   ('Berhampur-Gopalpur Region', 600000, ST_SetSRID(ST_MakeEnvelope(84.5, 19.0, 85.2, 19.5, 4326)::geography)),
--   ('Visakhapatnam Region', 1800000, ST_SetSRID(ST_MakeEnvelope(83.0, 17.4, 83.5, 18.0, 4326)::geography)),
--   ('Rajahmundry-Kakinada Region', 1200000, ST_SetSRID(ST_MakeEnvelope(81.5, 16.7, 82.5, 17.3, 4326)::geography)),
--   ('Guntur Region', 900000, ST_SetSRID(ST_MakeEnvelope(80.2, 16.0, 80.7, 16.5, 4326)::geography)),
--   ('Balasore Region', 500000, ST_SetSRID(ST_MakeEnvelope(86.5, 21.2, 87.2, 21.7, 4326)::geography)),
--   ('Rourkela-Sambalpur Region', 1100000, ST_SetSRID(ST_MakeEnvelope(83.8, 21.2, 85.0, 22.5, 4326)::geography));

-- Population: India mainland only, every area > 400 (oceans = 0, no zones in sea)
INSERT INTO population_zones (name, population, boundary) VALUES
  ('Bhubaneswar-Cuttack Region', 2500000, ST_MakeEnvelope(85.5, 20.0, 86.2, 20.6, 4326)::geography),
  ('Puri Coastal Region', 800000, ST_MakeEnvelope(85.6, 19.6, 86.0, 20.0, 4326)::geography),
  ('Berhampur-Gopalpur Region', 600000, ST_MakeEnvelope(84.5, 19.0, 85.2, 19.5, 4326)::geography),
  ('Visakhapatnam Region', 1800000, ST_MakeEnvelope(83.0, 17.4, 83.5, 18.0, 4326)::geography),
  ('Rajahmundry-Kakinada Region', 1200000, ST_MakeEnvelope(81.5, 16.7, 82.5, 17.3, 4326)::geography),
  ('Guntur Region', 900000, ST_MakeEnvelope(80.2, 16.0, 80.7, 16.5, 4326)::geography),
  ('Balasore Region', 500000, ST_MakeEnvelope(86.5, 21.2, 87.2, 21.7, 4326)::geography),
  ('Rourkela-Sambalpur Region', 1100000, ST_MakeEnvelope(83.8, 21.2, 85.0, 22.5, 4326)::geography),
  ('Bhadrak-Jajpur', 520, ST_MakeEnvelope(86.3, 20.9, 86.6, 21.2, 4326)::geography),
  ('Cuttack North', 680, ST_MakeEnvelope(85.7, 20.55, 86.0, 20.75, 4326)::geography),
  ('Puri Inland', 750, ST_MakeEnvelope(85.7, 19.7, 85.95, 19.95, 4326)::geography),
  ('Khordha', 620, ST_MakeEnvelope(85.6, 20.1, 85.85, 20.35, 4326)::geography),
  ('Ganjam Inland', 580, ST_MakeEnvelope(84.6, 19.2, 84.9, 19.5, 4326)::geography),
  ('Gajapati', 480, ST_MakeEnvelope(84.0, 18.9, 84.4, 19.2, 4326)::geography),
  ('Rayagada', 550, ST_MakeEnvelope(83.3, 19.1, 83.7, 19.5, 4326)::geography),
  ('Koraput Inland', 610, ST_MakeEnvelope(82.5, 18.6, 82.9, 19.0, 4326)::geography),
  ('Vizianagaram North', 530, ST_MakeEnvelope(83.5, 18.2, 83.85, 18.5, 4326)::geography),
  ('Srikakulam Inland', 490, ST_MakeEnvelope(83.9, 18.1, 84.2, 18.45, 4326)::geography),
  ('East Godavari', 720, ST_MakeEnvelope(81.8, 16.8, 82.2, 17.2, 4326)::geography),
  ('West Godavari', 650, ST_MakeEnvelope(81.0, 16.5, 81.4, 16.9, 4326)::geography),
  ('Krishna District', 580, ST_MakeEnvelope(80.5, 16.2, 80.9, 16.6, 4326)::geography),
  ('Prakasam', 540, ST_MakeEnvelope(79.9, 15.2, 80.3, 15.6, 4326)::geography),
  ('Nellore Inland', 600, ST_MakeEnvelope(79.7, 14.2, 80.1, 14.6, 4326)::geography),
  ('Chittoor North', 510, ST_MakeEnvelope(79.0, 13.5, 79.4, 13.9, 4326)::geography),
  ('Kurnool Region', 670, ST_MakeEnvelope(77.8, 15.6, 78.3, 16.0, 4326)::geography),
  ('Keonjhar', 590, ST_MakeEnvelope(85.5, 21.5, 86.0, 21.9, 4326)::geography),
  ('Mayurbhanj', 640, ST_MakeEnvelope(86.2, 21.7, 86.7, 22.2, 4326)::geography),
  ('Sundargarh', 570, ST_MakeEnvelope(84.0, 21.8, 84.5, 22.3, 4326)::geography),
  ('Jharsuguda', 500, ST_MakeEnvelope(83.9, 21.7, 84.3, 22.0, 4326)::geography);

COMMIT;

