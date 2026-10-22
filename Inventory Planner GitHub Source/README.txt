Inventory Planner — Replit import package (migration step 1)

This package preserves the current interface and tested inventory calculation rules. It is prepared for import, not yet a production deployment.

Included
- Portable Node.js server and browser interface; Node >=22.
- Python >=3.12 material allocation solver and pinned NumPy/SciPy requirements.
- Replit startup/build settings and planning checks.
- Sales/PO/work-order readers and direct settings search customsearch5042.

Excluded
Private keys, certificates, credentials, connection.json, cached reports, refresh history, actual item catalog and exports. The browser catalog starts empty and is filled from the authenticated server later.

First steps
1. Import this private GitHub repository into Replit using Import from GitHub.
2. Have Replit Agent read this README and Replit Handoff.txt.
3. Run the project. On Replit, it should show the import/setup page, because cloud inventory access is intentionally blocked pending step 2.
4. Add team authentication and approved-user authorization before removing the setup gate. Every report, refresh, status and session endpoint needs server-side authorization. A cookie issued to every visitor is not user sign-in.
5. Configure NetSuite credentials using Secrets after authentication. Expected names: NETSUITE_CLIENT_ID, NETSUITE_CERTIFICATE_ID, NETSUITE_PRIVATE_KEY_PEM. Never put key contents in source files or an Agent prompt. The private key must remain server-side.
6. Replace local data/ report files with persistent database storage before publishing. Files in a deployment are not the durable report store. Add a shared refresh lock/job status for multiple users/instances.
7. Verify Replit runtime/dependency installation and compare results with the local app before publishing.

Commands
python3 -m pip install -r requirements.txt
npm run build
npm test
npm start

Server uses PORT (default 3000) and HOST (default 0.0.0.0). PYTHON_BIN optionally selects Python. PLANNER_DATA_DIR defaults to data/ for local testing only. APP_ORIGIN must be validated and configured when implementing authentication; the localhost-only session and CSRF checks must be adapted, not discarded. Current setup gate remains active on Replit, regardless of APP_ORIGIN.

Verification completed here
Portable UI build, server startup on localhost, report access denial without a session, material solver execution, planning/work-order/reorder/yield checks. Replit import and Linux dependency installation have not been executed yet. This does not claim production readiness.

The original local planner is unchanged and remains available at http://127.0.0.1:8766/.

Usage history
Each refresh also reads 25 months of usage from NetSuite (read-only SuiteQL): quantities shipped on Pending Billing, Pending Billing/Partially Fulfilled and Billed sales orders (dated by the order ship date, or order date when blank) and work-order component consumption (WO issues and backflushed completions), grouped by month and rolled up to purchasing parents with item yields. The Usage history view averages daily use over the last 3/6/12/24 complete months and projects it across the planning horizon (projected use, days of cover, projected balance). It is a reference only; purchase suggestions still come from open orders, incoming supply and reorder points. If a history query fails, the last successful history read is kept (data/usage-raw.json) and the refresh still completes.
