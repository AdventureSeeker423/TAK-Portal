# Email Template Variables

<p>Below you can find a reference document for all available variables that are passed to the Email Templates</p>

{{displayName}} - The user's name formatted as `Last, First` <br>
{{lastName}} - The user's name formatted as `Last` <br>
{{lastNameUpper}} - The user's name formatted as `LAST` <br>
{{firstName}} - The user's name formatted as `First` <br>
{{username}} - The user's badge number and agency suffix formatted as `1234abcd` <br>

{{groupsCsv}} <br>
{{hasPassword}} <br>

{{removedGroupsCsv}} — comma-separated group names removed during the change window <br>
{{addedGroupsCsv}} — comma-separated group names added during the change window <br>

{{badgeNumber}} - The user's badge number formatted as `1234` <br>
{{agencyAbbreviation}} - The user's agency formatted as `ABCD` <br>
{{agencyColor}} - The user's agency color formatted as `Color` <br>
{{atakRole}} - The user's ATAK role formatted as `Team Member`, `Team Lead`, etc. <br>
{{stateAbbreviation}} - The two-letter state abbreviation for the user's agency (from Agencies config) <br>
{{county}} - The county name for the user's agency (from Agencies config) <br>
{{callsign}} - The user's callsign string, built from the configured Callsign Format in Server Settings <br>
{{takPortalPublicUrl}} - The TAK Portal Public URL <br>