function Get-AzADSPIStaleIdentity {
    <#
    .SYNOPSIS
    Computes stale identity verdicts for the enriched Service Principal collection ($cu).

    .DESCRIPTION
    Pure transformation - no API calls. Combines each object's service principal sign-in activity
    (from the beta reports/servicePrincipalSignInActivities report) with its account state, age and
    credentials to decide whether it is a stale identity candidate, and why.

    The logic mirrors Microsoft's 'Remove unused applications' recommendation:
    - only flags objects older than the threshold (freshly created apps are exempt)
    - managed identities are excluded from sign-in based staleness (their sign-ins are not covered by
      this report); they can still be flagged as disabled
    - external / multi-tenant resource principals (Microsoft and third-party apps consented into the
      tenant) are reported for information but not flagged as 'remove me' candidates

    Returns a hashtable keyed by $cu ObjectId; each value is a PSCustomObject:
      objectId, appId, kind, signInAvailable, lastSignIn, lastSignInDaysAgo,
      isStale, reasons (string[]), actionHint (string)

    .PARAMETER cu
    The enriched collection built during data collection.

    .PARAMETER SignInActivityByAppId
    Hashtable keyed by appId; values carry lastSignInDateTime and the four flow-specific timestamps
    (built from reports/servicePrincipalSignInActivities). Empty when sign-in collection was skipped
    or not permitted/licensed.

    .PARAMETER SignInDataAvailable
    $false when the sign-in activity report could not be collected (missing permission, beta/license,
    non-global cloud). Sign-in based reasons are then suppressed and only 'disabled' still applies.

    .PARAMETER StaleIdentityDays
    Inactivity threshold in days.

    .PARAMETER ReferenceDate
    'Now' for age/inactivity math (defaults to current UTC time; injectable for deterministic tests).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        $cu,

        [hashtable]
        $SignInActivityByAppId = @{},

        [bool]
        $SignInDataAvailable = $true,

        [int]
        $StaleIdentityDays = 90,

        [datetime]
        $ReferenceDate = ([datetime]::UtcNow)
    )

    $result = @{}

    function parseDate {
        param($value)
        if (-not $value) { return $null }
        try { return [datetime]::Parse($value, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::AdjustToUniversal) }
        catch { return $null }
    }

    foreach ($entryRaw in $cu) {
        $entry = $entryRaw
        if ($entry -is [System.Collections.IEnumerable] -and $entry -isnot [PSCustomObject] -and $entry -isnot [string]) {
            $entry = @($entry)[0]
        }
        if (-not $entry -or -not $entry.ObjectId) { continue }

        $objectType = [string]$entry.ObjectType
        $sp = $null
        if ($entry.PSObject.Properties['SP'] -and $entry.SP) { $sp = @($entry.SP)[0] }
        $app = $null
        if ($entry.PSObject.Properties['APP'] -and $entry.APP) { $app = @($entry.APP)[0] }

        #kind + appId + createdDateTime + accountEnabled
        $appId = $null
        $createdDateTime = $null
        $accountEnabled = $true
        if ($sp) {
            $appId = $sp.SPAppId
            $createdDateTime = $sp.SPCreatedDateTime
            if ($null -ne $sp.SPAccountEnabled) { $accountEnabled = [bool]$sp.SPAccountEnabled }
        }
        elseif ($app) {
            $appId = $app.APPAppClientId
            $createdDateTime = $app.APPCreatedDateTime
        }

        switch -Wildcard ($objectType) {
            'SP MI*' { $kind = 'mi' }
            'SP Agent Blueprint' { $kind = 'agentBp' }
            'SP Agent*' { $kind = 'agent' }
            'SP APP EXT' { $kind = 'external' }
            'SP EXT' { $kind = 'external' }
            'APP*' { $kind = 'appOnly' }
            default { $kind = 'internal' }
        }

        $isManagedIdentity = $kind -eq 'mi'
        $isExternal = $kind -eq 'external'

        #sign-in lookup
        $signInEntry = $null
        if ($appId -and $SignInActivityByAppId.ContainsKey([string]$appId)) { $signInEntry = $SignInActivityByAppId[[string]$appId] }
        $lastSignIn = $null
        if ($signInEntry) { $lastSignIn = parseDate $signInEntry.lastSignInDateTime }

        $created = parseDate $createdDateTime
        $recentlyCreated = $false
        if ($created -and ($ReferenceDate - $created).TotalDays -lt $StaleIdentityDays) { $recentlyCreated = $true }

        #sign-in availability for THIS object: MIs are never covered by this report
        $signInAvailableForObject = $SignInDataAvailable -and (-not $isManagedIdentity)

        $reasons = [System.Collections.ArrayList]@()
        $isStale = $false
        $lastSignInDaysAgo = $null

        #disabled account - reliable regardless of sign-in data
        if (-not $accountEnabled) {
            $null = $reasons.Add('account disabled')
            $isStale = $true
        }

        if ($signInAvailableForObject) {
            if ($lastSignIn) {
                $lastSignInDaysAgo = [math]::Floor(($ReferenceDate - $lastSignIn).TotalDays)
                if ($lastSignInDaysAgo -ge $StaleIdentityDays) {
                    $null = $reasons.Add("no sign-in for $($lastSignInDaysAgo) days")
                    $isStale = $true
                }
            }
            else {
                #no sign-in record at all - only meaningful once the object is older than the threshold
                if (-not $recentlyCreated) {
                    $null = $reasons.Add('never signed in')
                    $isStale = $true
                }
            }
        }

        #dead credentials: the app has secrets/certs but every one of them is expired, so it can no longer
        #authenticate as a client. This is independent of the sign-in report and works for managed identities' apps too.
        $credentials = [System.Collections.ArrayList]@()
        foreach ($credCollectionName in @('APPPasswordCredentials', 'APPKeyCredentials')) {
            if ($entry.PSObject.Properties[$credCollectionName] -and $entry.$credCollectionName) {
                foreach ($cred in $entry.$credCollectionName) { $null = $credentials.Add($cred) }
            }
        }
        if ($credentials.Count -gt 0 -and -not $isManagedIdentity) {
            $expiredCount = @($credentials.where({ [string]$_.expiryInfo -eq 'expired' })).Count
            if ($expiredCount -eq $credentials.Count) {
                $null = $reasons.Add("all $($credentials.Count) credential(s) expired")
                $isStale = $true
            }
        }

        #external/multi-tenant resource principals are reported but not treated as removable candidates
        if ($isStale -and $isExternal) {
            $isStale = $false
            $null = $reasons.Add('(external/multi-tenant - review, do not remove blindly)')
        }

        #action hint
        $actionHint = ''
        if ($isStale) {
            $ownerCount = 0
            if ($entry.PSObject.Properties['SPOwners'] -and $entry.SPOwners) { $ownerCount += @($entry.SPOwners).Count }
            if ($entry.PSObject.Properties['APPAppOwners'] -and $entry.APPAppOwners) { $ownerCount += @($entry.APPAppOwners).Count }
            if ($kind -eq 'agent') {
                $actionHint = 'Confirm with the agent sponsor, then disable and soft-delete if unused'
            }
            elseif ($ownerCount -gt 0) {
                $actionHint = 'Confirm with the owner(s), then disable (accountEnabled=false) before soft-deleting'
            }
            else {
                $actionHint = 'No owner to confirm with - investigate, then disable before soft-deleting'
            }
        }

        $result[[string]$entry.ObjectId] = [PSCustomObject]@{
            objectId = $entry.ObjectId
            appId = $appId
            kind = $kind
            signInAvailable = $signInAvailableForObject
            lastSignIn = $(if ($lastSignIn) { $lastSignIn.ToString('yyyy-MM-dd') } else { $null })
            lastSignInDaysAgo = $lastSignInDaysAgo
            isStale = $isStale
            reasons = @($reasons)
            actionHint = $actionHint
        }
    }

    return $result
}
