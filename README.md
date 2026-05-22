# Pasco Site Tracker

This is a clean rebuild of the Pasco SR-52 parcel tracker.

## What Works In This Version

- Map-first dashboard using Leaflet, not Google Maps.
- Satellite and road map toggle.
- 111 parcels loaded from the first Excel tab, `Pasco RT 52`.
- Outreach statuses:
  - Not Started
  - Reached Out
  - Active Dialogue
  - Under LOI
  - Dead
- Pin color is based on outreach status.
- Toggle target pins and sales comp dots independently on the map.
- SR-52 sales comps show only address, sale amount, sale date, acres, and price per acre.
- Click a pin or worklist row to edit property details, owner/contact details, status, last contacted date, follow-up date, next step, property notes, activity log, follow-ups, and document links.
- Worklist on the left for quickly scanning parcels without hunting on the map.
- Map, Pipeline, and List views all connected to the same parcel data.
- Deal snapshot fields: priority, follow-up date, last contacted date, next step, and property type.
- Activity log for dated call, email, meeting, text, and research history.
- Lightweight follow-ups for next steps and dates.
- Add a new pin manually or by locating an address.
- Archive or delete pins that no longer belong in the active tracker.
- Search, status filters, property type filter, and CSV export.
- Import future parcel lists from Excel, CSV, or tracker JSON. The import preview keeps existing parcels and adds only new ones.

## Current Storage

This version can save two ways:

- Local backup in your browser, so the tracker still works on your computer.
- Shared Supabase database, so the same pins, statuses, notes, and activity can be used by multiple people.

Supabase is configured in `supabase-config.js`. The app uses Supabase email/password login and database rules before it reads shared parcel data.

## Supabase Setup

1. Open Supabase.
2. Open the `Pasco Site Tracker` project.
3. Click `SQL Editor` in the left sidebar.
4. Click `New query`.
5. Paste the contents of `supabase-setup.sql`.
6. Click `Run`.
7. Open `Authentication` in Supabase and create the approved email/password user.
8. Refresh the tracker at `http://127.0.0.1:4173/` and sign in.

The sync label should change from local autosave to shared sync once the database table exists.

The SQL allowlist starts with `gregg.bazzani1@gmail.com`. To approve another login later, create that user in Supabase Authentication and add the email to `public.tracker_users`.

## Local Preview

Run a simple local server from this folder, then open the shown URL.

```powershell
python -m http.server 4173
```

Then open:

```text
http://localhost:4173
```

## Excel Source

The current parcel file was generated from:

```text
C:\Users\Owner\Documents\Business\Tampa Database\Data\Pasco\RT 52 MASTER TRACKER 5.18.26.xlsx
```

Only the first tab was included.

One row was skipped because it had no latitude or longitude:

```text
Excel row 5: 7401 RT 52
```

Sales comps were generated from the first tab of:

```text
C:\Users\Owner\Documents\Business\Tampa Database\Data\Pasco\Pasco 52 Land Comp Database.xlsx
```

The comp layer includes comp rows with the required sale fields and a geocoder-confirmed address. Rows without a reliable map location are skipped until they can be located confidently.

## For Future Imports

Use the app's Import button and select a new Excel or CSV file with the same general column structure. The app will preview:

- new parcels
- parcels already in the tracker
- possible existing records with changed data
- rows missing coordinates

Nothing is added until you confirm the import.

Extra columns in future Excel files, such as mortgage details, zoning notes, opportunity zone data, parcel IDs, or other property intelligence, are kept and shown under `Additional Data` in the property panel.

## Workflow Definitions

- Status: the high-level deal/outreach stage.
- Property Notes: durable property intelligence and strategy.
- Activity Log: dated history of calls, emails, texts, meetings, and research.
- Follow-Ups: lightweight next steps with dates and done/not done state.
