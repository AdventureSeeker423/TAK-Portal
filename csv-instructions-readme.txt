CSV User Creation Instructions
====================================

Use this with: sample-users.csv

CSV format (DO NOT change the header line except to optionally omit optional columns):
badge,agency,firstName,lastName,email,password,radioCallsign,template,role

What each column means:
1) badge
   - User badge number / username base (do not include username suffix).
   - Letters and numbers only (no spaces or special characters).

2) agency
   - Can be either:
     a) Agency abbreviation/prefix (example: TEST), OR
     b) Agency suffix (preferred).
   - Suffix is preferred as it will lead to less abbreviation conflicts.

3) firstName
   - User first name.

4) lastName
   - User last name.

5) email
   - Optional (can be blank).
   - Must be a valid email address.
   - No spaces (example: john.doe@agency.gov is valid, john.doe @agency.gov is NOT).

6) password
   - Optional (can be blank).
   - If you enter a password, it MUST include ALL of these:
     - at least 12 characters
     - at least 1 lowercase letter
     - at least 1 uppercase letter
     - at least 1 number
     - at least 1 symbol

7) radioCallsign  (optional)
   - Optional (can be blank or column omitted entirely).
   - If set, stored on the Authentik user as attribute radio_callsign.
   - Place before template when included in the header row.

8) template
   - This is the user group template name to apply to the new user.
   - Example from sample file: Patrol
   - The template must already exist for that agency, or that row will fail.

9) role  (optional – last column)
   - If this column is missing, left blank, or the value is empty, the new user's
     role is taken from the selected template (same as creating a user in the UI
     without overriding role).
   - If you set a value, it must be one of:
     Team Member, Team Lead, HQ, Sniper, Medic, Forward Observer, RTO, K9
   - Matching is not case-sensitive (e.g. "team lead" and "Team Lead" are both ok).

Quick rules:
- Keep the first row (header) as shown; you may omit optional columns
  (radioCallsign and/or role) for older spreadsheets.
- One user per line.
- Do not add other extra columns.
- Save as .csv.

Examples:
- Good row (role from template, with radio callsign):
  1001,TEST,John,Doe,john.doe@example.org,Password!23456,HCSO-1001,Patrol,
- Good row with blank password and explicit role (no radio callsign):
  1002,test,Jane,Smith,jane.smith@example.org,,,Patrol,Team Lead
