# Change Log

All notable changes to this project will be documented in this file.  Minor quality improvements or tweaks may not be listed.

Planned features can be accessed [here](docs/roadmap.md)

<!-- 🎉 `New Feature` - -->
<!-- ✨ `Enhancement` - -->
<!-- ✏️ `Documentation` - -->
<!-- 🐛 `Bug Fix` - Fixes issue with -->
<!-- ⬆️ `Dependency` - -->

## Version History

### v1.3.30 - 6/2/26
✨ `Enhancement` - Custom logos added to mutual aid events to reflect special logs for special events<br>
✨ `Enhancement` - Logo sizing, padding, and scaling cleaned across TAK Portal

### v1.3.29 - 6/2/26
✨ `Enhancement` - Adds mutual aid groups to Data Sync groups dropdown for global admins

### v1.3.28 - 6/2/26
🐛 `Bug Fix` - Fixes issue with role and template migrations attempting to run after assigning users a mutual aid group<br>
✨ `Enhancement` - Allow mutual aid incidents and events to have additional logins/sub-events.  (My use case: Have a "Master" MA group for a big event, and then create sub-incidents and sub-events using the existing mutual aid group to control access for each operational period, agency, etc...  Users needing access throughout the entire event will get the "master" group, but then others needing access only for a day or such can use the "sub" event user that feeds the same group for better access control.)

### v1.3.27 - 5/31/26
✨ `Enhancement` - Data Sync moved out of beta and can now be accessed by global and agency admins (more features to be added soon)<br>
🐛 `Bug Fix` - Fixes issue with tak_ naming showing up in random sections of the UI of the Groups and Mutual Aid page modals/popups

### v1.3.26 - 5/29/26
✨ `Enhancement` - Added a server abbreviation field in branding settings to better customize page titles.  Recommended layout is (XZYTAK)<br>
🐛 `Bug Fix` - Fixes issue with agency admins loading into "Setup My Device" page rather than dashboard upon login

### v1.3.25 - 5/29/26
🐛 `Bug Fix` - Fixes issue with SSH service not functioning properly for non-root users<br>
🐛 `Bug Fix` - Fixes issue with Locate returning a 404 error due to incorrect API permissions

### v1.3.24 - 5/27/26
✨ `Enhancement` - Added the ability to create custom fields on MOU Documents<br>
✨ `Enhancement` - Removed group prefixes from group update emails<br>
✨ `Enhancement` - Changed group update emails from "Previous Groups" and "Current Groups" to "Added Groups" and "Removed Groups" to give more relevant details<br>
✨ `Enhancement` - Added the ability for admins to approve or decline user requests from one-time links sent to their email without the need to fully login<br>
✨ `Enhancement` - Added loading and success notification to Pending User Requests Page when user creation is in progress<br>
✨ `Enhancement` - MOU Auditing is more detailed now<br>
🐛 `Bug Fix` - Fixes issue with Audit Log claiming users were rejected after being approved and created from the pending user requests page<br>
🐛 `Bug Fix` - Fixes issue with global admins not being notified after MOU Document is signed by agency

### v1.3.23 - 5/25/26
🐛 `Bug Fix` - Fixes issue with user agreement prompt not always prompting upon session change

### v1.3.22 - 5/25/26
🎉 `New Feature` - Added a fully functional MOU Documents section where global admins can create, edit, and manage serverwide and agency specific documents.  Agency admins can then e-sign or upload digial copies of the signed documents. If a document is set to be "serverwide" the document will automatically be assigned to new agencies as agency admins are created! Global admins can also set a serverwide user agreement prompt for every login.  (More enhancements and improvements in the next few days!)

### v1.3.21 - 5/23/26
✨ `Enhancement` - Radio Callsign added to Request Access page<br>
✨ `Enhancement` - QR Code for callsign, team, and role preferences added to TAK Aware instructions<br>
✨ `Enhancement` - Users page now displays onboarding qr and pref qr for users in admin views

### v1.3.20 - 5/22/26
✨ `Enhancement` - Updated logging service to include more events<br>
✨ `Enhancement` - Limited log file to 5gb max<br>
✨ `Enhancement` - Added ability for global admins to email agency admins

### v1.3.19 - 5/20/26
✨ `Enhancement` - Dashboard redesigned and all headers are now customized to better fit the needs of agency admins<br>
✨ `Enhancement` - Edits to agencies now trigger a server stats refresh for dashboards

### v1.3.18 - 5/20/26
✨ `Enhancement` - Added the ability to rename agency's full names and abbreviations. (Please be patient with large user count servers).<br>
✨ `Enhancement` - Cleaned up group filtering on the groups page for agency admins

### v1.3.17 - 5/20/26
🐛 `Bug Fix` - Fixes issue with email service caching old credentials till a restart<br>
🐛 `Bug Fix` - Fixes issue with sort order of templates on user edit modal<br>
✨ `Enhancement` - Adds a button to Users and to Groups pages to export csv lists (filtered for agency admins as well)<br>
✨ `Enhancement` - Cleaned up layout and buttons on Agencies page to better reflect the Users page<br>
✨ `Enhancement` - Agencies page better optimized for mobile

### v1.3.16 - 5/17/26
✨ `Enhancement` - Added a dedicated field for radio callsign<br>
✨ `Enhancement` - Cleaned up edit user modal<br>
✨ `Enhancement` - Added button to groups page to allow setting agency admin access for multiple agencies at once<br>
✨ `Enhancement` - Added dedicated mode for groups and templates pages on mobile 

### v1.3.15 - 5/14/26
✨ `Enhancement` - Added buttons to show TAK logs, Restart TAK Service, and Restart TAK Server to the server settings page to give basic commands for non-infraTAK environments.  Buttons will be hidden if SSH is not configured in TAK Portal.

### v1.3.14 - 5/12/26
✨ `Enhancement` - Added email logic and email template to send when a user is re-enabled after being disabled.<br>
✨ `Enhancement` - Popup tooltip added on password field when creating users to detail password requirements

### v1.3.13 - 5/11/26
🐛 `Bug Fix` - Fixes issue with agency admins unable to create users due to hidden agency field

### v1.3.12 - 5/7/26
✨ `Enhancement` - Template dropdown filter added to users page<br>
✨ `Enhancement` - Added bulk actions to data package manager<br>
✨ `Enhancement` - Hid non-relevant dropdowns from agency admins for User, Group, and Template creation<br>
🐛 `Bug Fix` - Fixes issue with JSON error upon template creation

### v1.3.11 - 5/6/26
✨ `Enhancement` - Added an option in settings to disable email updates upon editing user's groups

### v1.3.10 - 5/6/26
🎉 `New Feature` - Editing Templates now also makes group changes to existing users with that same template<br>
✨ `Enhancement` - Groups can now be mass assigned / unassigned from multiple templates at one time

### v1.3.9 - 5/6/26
🐛 `Bug Fix` - Fixes issue with user roles bouncing back to Team Member upon editing<br>
✨ `Enhancement` - Editing a user will now display the name of the template that is applied to users if their current user groups match a template

### v1.3.8 - 5/6/26
✨ `Enhancement` - Move server sided filtering based off suffix to query Authentik API user attributes<br>

### v1.3.7 - 5/6/26
✨ `Enhancement` - Began adding ability to change site wide fonts and primary button color<br>
✨ `Enhancement` - Added ability to edit text on Users, Pending User, and Request Access pages where it was originally hard coded to "Badge Number / Username / Radio Callsign"

### v1.3.6 - 5/5/26
🐛 `Bug Fix` - Fixes issue with standard users being redirected to the dashboard upon login.

### v1.3.5 - 5/4/26
✨ `Enhancement` - All pages re-optimized for mobile <br>
✨ `Enhancement` - Role dropdown added to approve pending user requests<br>
✨ `Enhancement` - User edit page cleaned up with enhancements to template and role changes<br>
✨ `Enhancement` - Site wide zoom updates to better display data on standard screens

### v1.3.4 - 5/1/26
✨ `Enhancement` - Updates all email templates to include proper role display<br>
✨ `Enhancement` - Updates all setup my device instructions to include proper callsign configurations<br>
✨ `Enhancement` - Adds Role (optional column) to User CSV import (if left blank it uses the role defined in the template)

### v1.3.3 - 5/1/26
🎉 `New Feature` - Roles have now been added to users and templates to aid in assisting users with device configuration.  Please update and then navigate to your users page to perform a quick user migration to default roles.

### v1.3.2 - 4/28/26
✨ `Enhancement` - Plugin Manager now allows multiple versions of a plugin to be downloaded for multiple versions of ATAK<br>
🐛 `Bug Fix` - Fixes issue with Plugin Manager link to TAK.gov only allowing a fixed list of ATAK versions.  Updated to always include the 4 most recent versions posted on tak.gov.

### v1.3.1 - 4/28/26
🐛 `Bug Fix` - Fixes issue with long load times on the Access Control page for servers with large amounts of users.

### v1.3.0 - 4/27/26
🎉 `New Feature` - Implementation and addition of a more robust permissions system centered around an Access Control page that is designed to customize permissions of admin users.  More updates to come in the near future to expand this functionality beyond the existing access levels!<br>
🐛 `Bug Fix` - Updates Open TAK Tracker link to fix issue with GoTAK removing their app from GitHub.

### v1.2.79 - 4/27/26
✨ `Enhancement` - Setup My Device page now features a cleaner UI to assist with flows and instructions<br>
✨ `Enhancement` - Instructions with dynamic callsigns and team colors have been added / improved<br>
✨ `Enhancement` - iTAK added as an option for Setup My Device - THIS IS DISABLED BY DEFAULT AND MUST BE ENABLED IN SERVER SETTINGS - TAK SERVER to use.

### v1.2.78 - 4/25/26
✨ `Enhancement` - Updated button order for creating a new user to match best UI practices<br>
🐛 `Bug Fix` - Fixes issue with standard users not being able to download plugins.

### v1.2.77 - 4/23/26
🎉 `New Feature` - Agencies can now be imported by CSV for mass creation

### v1.2.76 - 4/23/26
✨ `Enhancement` - Allow periods to be used in usernames<br>
✨ `Enhancement` - Server Settings option added to set default appearance for pages

### v1.2.75 - 4/22/26
✨ `Enhancement` - Revert recent changes to allow usernames to include dashes and underscores.  Sorry y'all!

### v1.2.74 - 4/18/26
🎉 `New Feature` - Added Data Package Manager for global admins.  A current limitation is that any uploaded DP from TAK Portal will result with all groups/channels having access.

### v1.2.73 - 4/16/26
✨ `Enhancement` - Adds CSV Template and Instructions download link to user creation page<br>
🐛 `Bug Fix` - Fixes issue with Authentik email validation hiding TAK Portal progress when an invalid email format is entered.

### v1.2.72 - 4/15/26
✨ `Enhancement` - Modifies username field on creation and request access pages to only accept usernames with letters and numbers only (No special characters)

### v1.2.71 - 4/15/26
🐛 `Bug Fix` - Fixes issue with logout invalidation flow<br>
🐛 `Bug Fix` - Fixes issue with Bug: req.protocol returns http behind reverse proxy <br>
🐛 `Bug Fix` - Fixes issue with incorrect filtering of agnencies with similar suffixes

### v1.2.70 - 4/13/26
✨ `Enhancement` - Adds a column to display port on the integrations page<br>
🐛 `Bug Fix` - Fixes issue with Data Streaming Feed creation failing due to a TAK Server limitation of 30 characters.

### v1.2.69 - 4/12/26
✨ `Enhancement` - Adds auto-save to server settings page<br>
✨ `Enhancement` - Adds Default Role column to Data Sync page <br>
🎉 `New Feature` - Created Documents page for beta mode users.  More updates to come soon for further devolopment.

### v1.2.68 - 4/8/26
✨ `Enhancement` - Integrations page now includes a way to create Data Feeds on TAK Server (additions compliments of cfd2474)<br>
🐛 `Bug Fix` - Fixes issue with QR code behavior for standard users failing to load the enrollment QR code on the setup my device page (bug reported by dfndr13)


### v1.2.67 - 4/4/26
🐛 `Bug Fix` - Fixes issue with locate failing if user inputs characters such as apostrophes and other special characters.  Handling added to remove and replace characters. (TAK Server limitation)

### v1.2.66 - 4/3/26
✨ `Enhancement` - Added ability to edit agency type for existing agencies and adds an "Edit Agency Attributes" button.

### v1.2.65 - 4/3/26
🎉 `New Feature` - Locate Persons page is out of beta and now available to any global admin and includes options for group/channel only, as well as data sync.  More updates to come soon with a form editor.<br>
✨ `Enhancement` - Agencies page now adds a dropdown for color in the existing agencies table, allowing you to modify the assigned colors to existing agencies.

### v1.2.64 - 4/1/26
✨ `Enhancement` - Rearranged sidebar admministration links to appear alphabetically<br>
🐛 `Bug Fix` - Fixes issue with beta features being shown to non-global admin users in the sidebar

### v1.2.63 - 4/1/26
🎉 `New Feature` - Added new page for Data Sync Mission Management.  This feature is limited to servers with beta mode enabled in settings and global admins only.  More work to be released soon!

### v1.2.62 - 4/1/26
✨ `Enhancement` - Integrations page download certs now downloads the .p12 in the zip bundle.<br>
✨ `Enhancement` - Added User creation in progress status indicator on the user page.<br>
✨ `Enhancement` - Added audit logging functionality to Locate page

### v1.2.61 - 3/28/26
🎉 `New Feature` - Added Locate Persons page (Beta mode must be enabled in settings).  This page will continue to get updates in the next few days, but can be used as a beta feature to send a link to a lost person and their location will report back and be logged in both TAK Portal and TAK Server (channels only right now, data sync to be added later this week).<br>
✨ `Enhancement` - First Name Initial and Last Name Initial added as options in the callsign format settings.<br>
✨ `Enhancement` - Added settings for Twillio and Brevo to use alongside Locate page, however testing has not been completed on this.

### v1.2.60 - 3/23/26
✨ `Enhancement` - When deleting an integration, TAK Portal will now delete the certificate files from TAK Server after revokation.

### v1.2.59 - 3/23/26
🎉 `New Feature` - Integrations page now creates and revokes .pem and .key certificates in TAK Server and allows for easy downloading. (Dependent upon configuring SSH Key in settings)<br>
✨ `Enhancement` - TAK Server Settings now include a place to generate an SSH key to the TAK Server

### v1.2.58 - 3/22/26
✨ `Enhancement` - Added the ability to set a new user as an Agency Admin or Global admin during creation<br>
✨ `Enhancement` - Added the ability to add additional agency types in settings.

### v1.2.57 - 3/21/26
✨ `Enhancement` - Added the ability to lock the request access page to only submit if the user's email domain matches the selected agency. (Configured on the agencies page for global admins)

### v1.2.56 - 3/21/26
✨ `Enhancement` - Many backend  improvements to Groups and Mutual Aid pages to make view members, mass assign, and mass unassign load and perform quicker.<br>
✨ `Enhancement` - Renamed "Private" group label to "Hide From Agency Admins" as this is the only case where a group can't be hidden from the manage access section of agencies.<br>
✨ `Enhancement` - Added a button to export Audit Log CSV file

### v1.2.55 - 3/20/26
🐛 `Bug Fix` - Temporarily removing "Role" column from the users page as that was causing massive load time performance issues.

### v1.2.54 - 3/20/26
✨ `Enhancement` - Adds eyeball/visibility icon to password reset edit modal<br>
🐛 `Bug Fix` - Fixes issue with Agencies not displaying as a dropdown on the users page

### v1.2.53 - 3/19/26
✨ `Enhancement` - Adds filters to groups page<br>
✨ `Enhancement` - Adds filters and search bar to templates page<br>
🐛 `Bug Fix` - Fixes issue with Portal Auth breaking allowed agency suffix logic if portal auth is disabled

### v1.2.52 - 3/19/26
✨ `Enhancement` - Added the ability for global admins to filter the users page by agency.<br>
🐛 `Bug Fix` - Fixes issue with Global Admins seeing user pages with less than 25 users.

### v1.2.51 - 3/18/26
🐛 `Bug Fix` - Attempts to improve load times on the users page by moving more queries to Authentik.

### v1.2.50 - 3/17/26
🐛 `Bug Fix` - Fixes issue with sidebar not allowing for scroll on small / mobile devices

### v1.2.49 - 3/16/26
🎉 `New Feature` - Added a plugin manager and plugin page to support hosting ATAK Plugins from TAK Portal.  The plugin manager can be linked to your tak.gov account to automatically discover and download plugins.<br>
✨ `Enhancement` - Charts on the dashboard now follow color structure of the agencies page.

### v1.2.48 - 3/16/26
🎉 `New Feature` - Adds the ability for Global admins to email all users<br>
🎉 `New Feature` - Adds the ability for Global or Agency admins to email users filtered by agency, groups, or specific users<br>
✨ `Enhancement` - Connected clients are now clickable to list active channels that the user has enabled<br>
✨ `Enhancement` - Sidebar is now in a tabbed structure, allowing for grouping of pages as features grow<br>
✨ `Enhancement` - Beta mode toggle now added in settings to control visibility of pages in progress <br>
✨ `Enhancement` - Light/Dark mode now controlled per user device, rather than server-wide, in the top-right header

### v1.2.47 - 3/13/26
✨ `Enhancement` - Adds USA, FED, and OTHER to state options to support federal partners and other states not listed

### v1.2.46 - 3/13/26
🐛 `Bug Fix` - Fixes issue with incorrect user and integration counts on servers with large user counts.  Added functions to preserve old data until new calculations are performed

### v1.2.45 - 3/13/26
✨ `Enhancement` - Adds a Status pill to the Integrations page to show which integrations are connected to TAK server<br>
✨ `Enhancement` - Makes "Connected Users / Clients" clickable on the dashboard to open a list of connected users<br>
✨ `Enhancement` - Adjusts Connected Users / Clients total count to subtract connected integrations 

### 1.2.44 - 3/12/26
🐛 `Bug Fix` - Fixes Mutual Aid Bug -  when the global admin modifies the type of Mutual Aid on an existing group, the group is no longer renamed or changed.  Also added checks to ensure existing groups can not be modified by mutual aid.

### v1.2.43 - 3/12/26
✨ `Enhancement` - Adds county codes/abbreviations to the agencies page.  All existing agencies should select the update button to input county abbreviations for existing agencies.<br>
✨ `Enhancement` - Adds county codes and agency type abbreviations to the callsign format options.<br>
✨ `Enhancement` - Changes wording on all pages and changes Badge Number to Badge Number / Radio ID / Callsign to accommodate more user vocabulary. 


### v1.2.42 - 3/11/26
🎉 `New Feature` - Adds ATAK Preferences Configuration QR Code to automatically set the user's callsign, team, and role in ATAK.<br>
✨ `Enhancement` - Adds instructions to TAK Aware for manually setting callsign, team, and role.

### v1.2.41 - 3/11/26
🎉 `New Feature` - Adds the ability to customize the callsign format in server settings.<br>
✨ `Enhancement` - Adds Android link for Open TAK Tracker to the Setup My Device page.

### v1.2.40 - 3/11/26
✨ `Enhancement` - Modified to check for updates every 15 min rather than 1 hr.<br>
✨ `Enhancement` - Added an "Open URL" button to the setup my device QR Code to avoid using a second device.<br>
✨ `Enhancement` - Modified audit log to include better optimized dropdown filters

### v1.2.39 - 3/10/26
🐛 `Bug Fix` - Fixes issue with Agency Admins getting blocked from accessing the pending user requests page

### v1.2.38 - 3/10/26
🐛 `Bug Fix` - Fixes email template issue with incorrect coloring in Microsoft email clients

### v1.2.37 - 3/10/26
✨ `Enhancement` - Adds Agency column to the users page<br>
✨ `Enhancement` - Adds more details to show on the audit log<br>
✨ `Enhancement` - Remove "Beta" tag on Audit Log<br>
🐛 `Bug Fix` - Improves loading time on users and groups page

### v1.2.36 - 3/8/26
✨ `Enhancement` - Added an indicator in the sidebar to highlight/bold the current page to assist with easier navigation

### v1.2.35 - 3/8/26
✨ `Enhancement` - Makes Stats cards on the dashboard clickable to their respective pages.

### v1.2.34 - 3/8/26
✨ `Enhancement` - Added an integration total count to the dashboard if integrations exist<br>
✨ `Enhancement` - Cleans up spacing on the dashboard page.

### v1.2.33 - 3/8/26
🎉 `New Feature` - Adds a Manage Access button to the Agencies page, allowing Global Admins to customize what groups, Agency Administrators have access to assign/unassign.<br>
🐛 `Bug Fix` - Adds better rules for Agency Admins to Assign/Unassign groups when using the "Users With Existing Groups" modal.  Agency Admins can't edit users outside of their own agency.


### v1.2.32 - 3/8/26
🎉 `New Feature` - Adds an Integrations page to create and assign the group for integration LDAP users for nodered or other integrations.  A cert will still need to be manually created on the TAK server and uploaded to NodeRed or similar for authentication.  This will likely be implemented in future releases <br>
✨ `Enhancement` - Removes unused QR code page which has been depreciated and unused since early releases.


### v1.2.31 - 3/3/26
✨ `Enhancement` - Adds a "Resend Onboarding" Button to the Users Edit page<br>
🐛 `Bug Fix` - Fixes issue with Users Edit page not giving proper feedback or reloading changes when names, email, etc are updated

### v1.2.30 - 3/3/26
🐛 `Bug Fix` - Fixes issue with Agency Admins not being able to see global groups<br>
🐛 `Bug Fix` - Fixes issue with Agency Admins not being able to assign global groups<br>
🐛 `Bug Fix` - Fixes issue with incorrect order of groups when editing a user<br>
🐛 `Bug Fix` - Fixes issue with hidden prefix groups showing on the templates page<br>
🐛 `Bug Fix` - Fixes issue with hidden prefix groups showing on the groups page

### v1.2.29 - 3/3/26
🐛 `Bug Fix` - Fixes issue with incorrect sort order of users names <br>
🐛 `Bug Fix` - Fixes issue with incorrect total user counts on the users page<br>
✨ `Enhancement` - Makes Role column sortable on the users page

### v1.2.28 - 3/2/26
✨ `Enhancement` - Added eyeball toggle in Server Settings to hide Authentik API Token and Client P12 Password by default

### v1.2.27 - 3/2/26
✨ `Enhancement` - Updated Server Settings to display a "Installed" or "Not Installed" chip beside the TAK Server Client and Certificate upload fields to indicate if a file has been uploaded

### v1.2.26 - 3/1/26
✨ `Enhancement` - Make agency dropdown sort alphabetically on the Templates Page<br>
✨ `Enhancement` - Remove "TWRA" from Agency Type (sorry Tennessee) and replace with "Game Warden" on Agencies Page <br>
🐛 `Bug Fix` - Fixes Templates page, when searching for groups it would clear the previous selections

### v1.2.25 - 3/1/26
🐛 `Bug Fix` - Fixes issue with update notification remaining in sidebar rather than in a modal popup

### v1.2.24 - 3/1/26
🐛 `Bug Fix` - Fixes issue with incorrect user totals on User paging system (removed the count but left "Page 1 of x")
🐛 `Bug Fix` - Fixes issue with hidden groups appearing as UIDs
🐛 `Bug Fix` - Fixes issue with count of groups shown on dashboard including hidden groups

### v1.2.23 - 2/28/26
✨ `Enhancement` - Removes (failed) auto-updater to make way for a special project with AJ. Reverts to previous update instructions.

### v1.2.22 - 2/28/26
🐛 `Bug Fix` - Fixes issue with authentication introduced by 1.2.21.  Agency admins and users had unrestricted access to protected pages.

### v1.2.21 - 2/28/26
🎉 `New Feature` - Added a /lookup page to better cater to agencies who have shared/apparatus accounts.  If enabled on the agencies page by a global admin, users can go to takportal.agency.gov/lookup and enter their email address and requested username.  If their email matches the domain provided by the admin and the requested username exists without an email address listed, that QR code gets emailed to the requesting user.

### v1.2.20 - 2/28/26
🐛 `Bug Fix` - Fixes issue with groups not appearing in TAK Portal due to changes in Authentik API 2025.12 and 2026.2.  It is recommended that all users update Authentik to version 2026.2.

### v1.2.19 - 2/27/26
✨ `Enhancement` - Modifies email verbiage prompting the user with better instructions to set a password

### v1.2.18 - 2/24/26
🐛 `Bug Fix` - Fixes issue with the wrong template being applied to user creations from manual creation and from pending users. Changed from index based to name based.

### v1.2.17 - 2/23/26
✨ `Enhancement` - Changes Pending User Request page to display agency abbreviation, rather than suffix<br>
✨ `Enhancement` - Audit Log now displays time based off local web browser, rather than UTC

### v1.2.16 - 2/22/26
🎉 `New Feature` - Added an Audit Log viewable only by Global Administrators.  This is in ***BETA*** and there are many known issues to be addressed in the near future.

### v1.2.15 - 2/22/26
✨ `Enhancement` - Adds sortable columns to Pending User Requests <br>
✨ `Enhancement` - Changes display of Other / Not Listed agency info on Pending User Requests page and modifies "Approve" button to be a "Review Request" button for "Other"<br>

### v1.2.14 - 2/22/26
✨ `Enhancement` - Modified Pending User Requests page to accept requests inline rather than at the bottom of the page. <br>
🐛 `Bug Fix` - Fixes issue with password field on the pending user requests page not displaying as full width <br>
🐛 `Bug Fix` - Fixes issue with password field on the pending user requests page not validating passwords properly.  Cleaned up logic for the Pending User Requests Page and Users page to behave identically.

### v1.2.13 - 2/22/26
✨ `Enhancement` - Adds an additional dropdown option on the edit user page for converting existing users to global admins. This also in turn hides the global admins from agency admins to protect permission overrides from a lower level.

### v1.2.12 - 2/21/26
🐛 `Bug Fix` - More fixes for updater script

### v1.2.11 - 2/21/26
🐛 `Bug Fix` - Attempts to fix issues with Web UI Updater Failing <br>
✨ `Enhancement` - Request Access page now uses agency abbreviation rather than suffix

### v1.2.10 - 2/21/26
✨ `Enhancement` - Added hCaptcha to the request access page.  A free account can be created at hCaptcha.com and the site/secret keys can be placed in the TAK Portal settings.

### v1.2.9 - 2/21/26
🐛 `Bug Fix` - Fixes issue with updater service not performing all functions for a proper docker update

### v1.2.8 - 2/21/26
✨ `Enhancement` - Modified CSS to improve the UI Updater Functionality

### v1.2.7 - 2/21/26
✨ `Enhancement` - User Request form notifies Agency Admins upon user requests for each agency via email, if no Agency Admin is set or if the agency does not exist, email gets sent to the Global Admin. <br>
🐛 `Bug Fix` - Fixes formatting issues on Request Access page

### v1.2.6 - 2/20/26
🎉 `New Feature` - Version bump to test new auto updater Web UI

### v1.2.5 - 2/20/26
🎉 `New Feature` - Added a "Request Access" page and handling for Global and Agency Admins - Agency Admins can manage their own agency's requests. (More enhancements on this to come soon)<br>
✨ `Enhancement` - Made Dashboard Mutual Aid Banners Clickable for Global Admins <br>

### v1.2.4 - 2/20/26
✨ `Enhancement` - Adds State Wide Group creation for Global Admins with the ability for Agency Admins to assign the group

### v1.2.3 - 2/17/26
✨ `Enhancement` - Adds a state dropdown to agency creation (not currently implemented elsewhere, but here for future planning)

### v1.2.2 - 2/17/26
✨ `Enhancement` - Normalizes usernames to be all lowercase without spaces

### v1.2.1 - 2/17/26
✨ `Enhancement` - Allows for users to be created with a username other than numbers and makes email field optional <br>
🐛 `Bug Fix` - Fixes issue with agency admin groups getting created with a "tak_" prefix

### v1.2.0 - 2/1/26
✨ `Enhancement` - Removes 'Create Users' page and combines it with 'Manage Users' as a single 'Users' page <br>
🐛 `Bug Fix` - Cleans up weird looks with Templates page

### v1.1.51 - 2/1/26
🎉 `New Feature` - Added an 'Email Packet' button to Mutual Aid QR Codes, allowing you to email out the deployment packet to an IC or others without the need to download it first and manually email it.

### v1.1.50 - 1/28/26
✨ `Enhancement` - Group formatting names and CN now adjusted to pass proper attributes such as name and description to TAK <br>
🐛 `Bug Fix` - Fixes issue with changing a group's private settings

### v1.1.49 - 1/26/26
✨ `Enhancement` - Minor Update - Simplified sidebar navigation wording

### v1.1.48 - 1/25/26
✨ `Enhancement` - Removed dash for group naming - groups are now "AGENCY Title" or "County Co Title"

### v1.1.47 - 1/20/26
✨ `Enhancement` - Adds sorting to Groups, Templates, and Mutual Aid. Template creation form order also adjusted to match the order of other pages. <br>
✨ `Enhancement` - Adds "Private" column to Groups <br>
🐛 `Bug Fix` - Fixes issue with incorrect permissions blocking agency admins from editing templates belonging to their agency

### v1.1.46 - 1/20/26
✨ `Enhancement` - Added "Manual Login" button to the Setup My Device page to provide manual cert enrollment instructions for each device type

### v1.1.45 - 1/17/26
✨ `Enhancement` - Updated PDF Layout to include device enrollment instructions

### v1.1.44 - 1/17/26
🐛 `Bug Fix` - Fixes issue with Mutual Aid not setting password properly

### v1.1.43 - 1/17/26
🎉 `New Feature` - Added a "Deployment Packet" in Mutual Aid to provide a PDF document to be used at CP for onboarding arriving assets, not already on the TAK system <br>
🎉 `New Feature` - Added custom settings in Server Settings to define colors and roles for deployment packet

### v1.1.42 - 1/16/26
✨ `Enhancement` - Adds "Role" to manage users columns <br>
✨ `Enhancement` - Allows for reordering / deleting / adding bookmarks<br>
🐛 `Bug Fix` - Fixes issue with using a template and accidentally overwriting a user's agency admin group <br>
🐛 `Bug Fix` - Fixes issue with agency admin groups not appearing properly in the groups list <br>
🐛 `Bug Fix` - Fixes issue with incorrect user counts on Manage Users page for Global Admins

### v1.1.41 - 1/16/26
✨ `Enhancement` - Creating an agency will now auto create a group in authentik for that agency's admins. Existing agencies should be deleted and recreated to get this update. <br>
✨ `Enhancement` - Added ability to assign users to agency admin under the edit user button

### v1.1.40 - 1/15/26
🎉 `New Feature` - Added "Standby" option to Mutual Aid to allow for non-critical, generic user MA instances to be created for operational readiness <br>
🎉 `New Feature` - New Mutual Aid instances can now create a new channel or use an existing one <br>
🐛 `Bug Fix` - Fixes issue with Agency displaying the suffix on templates <br>
🐛 `Bug Fix` - Fixes issue with Agency Templates tab getting hidden from Agency Admins <br>

### v1.1.39 - 1/15/26
✨ `Enhancement` - Updated all email templates to maximize compatibly with various email clients with a primary focus on Outlook and Gmail.

### v1.1.38 - 1/14/26
✨ `Enhancement` - Update to restart script <br>
✨ `Enhancement` - Minor behavior tweaks

### v1.1.37 - 1/13/26
🐛 `Bug Fix` - Fixes issue with SMTP not sending emails when it experiences a TLS cert mismatch.  Email service now ignores TLS errors.

### v1.1.36 - 1/12/26
🐛 `Bug Fix` - Fixes issue with incorrect email conditional formatting <br>
🐛 `Bug Fix` - Fixes issue with incorrect settings format for SMTP `From` Address.  All existing users should remove the quotes around the text in that field <br>
✨ `Enhancement` - Email formatting cleaned up and optimized for readability

### v1.1.35 - 1/12/26
⬆️ `Dependency` - Updated DockerFile to manage certificates for SMTP

### v1.1.34 - 1/12/26
✨ `Enhancement` - Major reduction in loading time for all users performing the "View Members" function on groups

### v1.1.33 - 1/12/26
✨ `Enhancement` - MAJOR reduction in loading time for agency admins navigating to the manage users section.  Load time cut down by 3/4.  Changed logic from looking at username suffixes to looking at authentik user attributes.

### v1.1.32 - 1/12/26
✨ `Enhancement` - Added the ability to make a channel "Private" so that it is hidden from Agency Admins (My use will be sensitive groups and WRITE groups for data feeds from NodeRed)

### v1.1.31 - 1/11/26
✨ `Enhancement` - Added "Color Override" to agency templates so that users created with certain templates would be assigned a special color, different from their agency (ex... SWAT to get a differing color) <br>
✨ `Enhancement` - Adjusted the service for new user emails to reflect the template override color

### v1.1.30 - 1/11/26
✨ `Enhancement` - Added CloudTAK URL to settings and Setup My Device pages <br>
✨ `Enhancement` - Added setting variable to pass TAK Portal Public URL to email templates <br>
✨ `Enhancement` - Updated email templates to default to the TAK Public URL, but fall back to contact TAK Portal Admin if variable isn't set

### v1.1.29 - 1/10/26
🐛 `Bug Fix` - Fixes issue with Agency Templates not appearing in sidebar

### v1.1.28 - 1/10/26
✨ `Enhancement` - Added "Import Configuration" button to the Server Settings

### v1.1.27 - 1/10/26
✨ `Enhancement` - Added caching service for dashboard to speed up page loading times <br>
🐛 `Bug Fix` - Removed CPU and Memory Usage till I can get a more accurate number

### v1.1.26 - 1/10/26
🐛 `Bug Fix` - Fixes issue with not being able to log in on initial install due to authentication being disabled

### v1.1.25 - 1/9/26
✨ `Enhancement` - Updated modal for editing a user

### v1.1.24 - 1/9/26
✨ `Enhancement` - Adds QR button to each user on manage users page <br>
🐛 `Bug Fix` - Fixes issue with Disable/Delete Buttons not working

### v1.1.23 - 1/9/26
🎉 `New Feature` - Added TAK Server Health Stats to Dashboard

### v1.1.22 - 1/9/26
✨ `Enhancement` - Modified Setup My Device Buttons and Behaviors

### v1.1.21 - 1/9/26
🎉 `New Feature` - Added a Scan QR Code Option in the Setup My Device page that creates a short term QR Code login, good for 30 min. <br>
✨ `Enhancement` - Removed the QR Code Generator from sidebar temporarily as it should no longer be needed.

### v1.1.20 - 1/8/26
🎉 `New Feature` - Added a "Setup My Device" page to guide users through the TAK setup process.  This page is not 100% functional and will continue to see updates to bring it to full functionality.

### v1.1.19 - 1/6/26
✨ `Enhancement` - Added argument to navigate to the docker data volume using ./takportal data

### v1.1.18 - 1/6/26
🎉 `New Feature` - Added ability to edit email templates from the Server Settings page

### v1.1.17 - 1/5/26
✨ `Enhancement` - Added Agency Abbreviation, Agency Color, and Badge Number to Email Templates and Email Template Variables <br>
✨ `Enhancement` - Adjusted window width for the sidebar to hide<br>
✨ `Enhancement` - Added Agency Color to the agency table <br>
✏️ `Documentation` - Created email-template-variables.md to track available email variables

### v1.1.16 - 1/5/26
✨ `Enhancement` - Added Agency Color Selection <br>

### v1.1.15 - 1/2/26
🎉 `New Feature` - Added ability to test SMTP configuration <br>
🐛 `Bug Fix` - Removes unneeded Agency Admin Group Setting from Setting Page

### v1.1.14 - 1/1/26
✨ `Enhancement` - All pages now 100% Mobile Friendly <br>
🐛 `Bug Fix` - Fixes issue with Templates not appearing for Creating Users

### v1.1.13 - 1/1/26
✏️ `Documentation` - Addition of Change Log file <br>
🎉 `New Feature` - Adds Update Available pill in sidebar<br>
🐛 `Bug Fix` - Fixes issue with Templates not appearing in Manage Users<br>