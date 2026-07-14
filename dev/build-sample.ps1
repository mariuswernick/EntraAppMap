<#
.SYNOPSIS
Offline dev harness: runs the real Build-AzADSPIMapData function against dev/sample-cu.json
and emits dev/sample-report.html using the exact same CSS/JS assets the main script inlines.

.DESCRIPTION
Use this to validate builder changes without a tenant:
    pwsh -NoProfile -File dev/build-sample.ps1
Then open dev/sample-report.html in a browser.
For pure front-end iteration (no PowerShell required) open dev/preview.html instead.
#>
[CmdletBinding()]
param(
    [string]$OutputFile = (Join-Path $PSScriptRoot 'sample-report.html'),
    [switch]$IncludeUnclassifiedPermissions
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent

. (Join-Path $repoRoot 'pwsh' 'functions' 'Build-AzADSPIMapData.ps1')
. (Join-Path $repoRoot 'pwsh' 'functions' 'Get-AzADSPIStaleIdentity.ps1')

$cu = Get-Content -Raw (Join-Path $PSScriptRoot 'sample-cu.json') | ConvertFrom-Json

#mock sponsors for the sample agent identity (mirrors $htAgentSponsors built by the main script)
$agentSponsors = @{
    '10000000-0000-0000-0000-000000000011' = @(
        @{ id = '40000000-0000-0000-0000-000000000001'; displayName = 'Ava Meyer'; type = 'user' }
    )
}

#mock service principal sign-in activity keyed by appId (mirrors $htSignInActivityByAppId built by the main script)
$referenceDate = [datetime]'2026-07-14T00:00:00Z'
$signInActivityByAppId = @{
    #HR Sync Service - recently active (not stale)
    '20000000-0000-0000-0000-000000000001' = [PSCustomObject]@{ lastSignInDateTime = '2026-07-01T09:00:00Z' }
    #Adobe (external) - inactive but external, reported for review only
    '20000000-0000-0000-0000-000000000002' = [PSCustomObject]@{ lastSignInDateTime = '2024-01-01T09:00:00Z' }
    #note: no entry for the orphaned app-only registration -> 'never signed in'
}
$staleness = Get-AzADSPIStaleIdentity -cu $cu -SignInActivityByAppId $signInActivityByAppId -SignInDataAvailable $true -StaleIdentityDays 90 -ReferenceDate $referenceDate

$changeState = @{
    '10000000-0000-0000-0000-000000000001' = 'changed'
    '60000000-0000-0000-0000-000000000002' = 'added'
}
$changeFields = @{ '10000000-0000-0000-0000-000000000001' = @('SPAppRoleAssignments', 'APPPasswordCredentials') }
$removedIdentities = @([PSCustomObject]@{ objectId = '70000000-0000-0000-0000-000000000001'; objectType = 'SP APP INT'; label = 'Removed legacy connector'; appId = '70000000-0000-0000-0000-000000000002' })
$mapData = Build-AzADSPIMapData -cu $cu -IncludeUnclassifiedPermissions:$IncludeUnclassifiedPermissions -AgentSponsors $agentSponsors -Staleness $staleness -ChangeState $changeState -ChangeFields $changeFields -RemovedStateCount 1 -RemovedIdentities $removedIdentities
Write-Host "Built map data: $($mapData.stats.nodeCount) nodes, $($mapData.stats.edgeCount) edges ($($mapData.stats.criticalNodeCount) critical, $($mapData.stats.mediumNodeCount) medium)"

#sanity checks - fail loudly on schema drift
$htNodeIds = @{}
foreach ($node in $mapData.nodes) {
    if (-not $node.id -or -not $node.t -or -not $node.l) { throw "node missing id/t/l: $($node | ConvertTo-Json -Compress)" }
    if ($htNodeIds.ContainsKey($node.id)) { throw "duplicate node id: $($node.id)" }
    $htNodeIds[$node.id] = $true
}
foreach ($edge in $mapData.edges) {
    if (-not $htNodeIds.ContainsKey($edge.s)) { throw "edge source not found: $($edge.s)" }
    if (-not $htNodeIds.ContainsKey($edge.d)) { throw "edge target not found: $($edge.d)" }
}
$criticalPermNode = $mapData.nodes | Where-Object { $_.t -eq 'permApp' -and $_.r -eq 'critical' } | Select-Object -First 1
if (-not $criticalPermNode) { throw 'expected at least one critical application permission node from sample-cu.json' }
$agentNode = $mapData.nodes | Where-Object { $_.t -eq 'agent' } | Select-Object -First 1
if (-not $agentNode) { throw 'expected at least one agent identity node from sample-cu.json' }
$blueprintEdge = $mapData.edges | Where-Object { $_.k -eq 'instanceOf' } | Select-Object -First 1
if (-not $blueprintEdge) { throw 'expected an instanceOf edge linking agent identity to its blueprint principal' }
$sponsorEdge = $mapData.edges | Where-Object { $_.k -eq 'sponsors' } | Select-Object -First 1
if (-not $sponsorEdge) { throw 'expected a sponsors edge for the sample agent identity' }
$sponsorlessAgent = $mapData.nodes | Where-Object { $_.t -eq 'agent' -and $_.m.noSponsor } | Select-Object -First 1
if (-not $sponsorlessAgent) { throw 'expected the sponsorless agent identity to be flagged (m.noSponsor)' }

#stale identity checks: the orphaned app-only registration has no sign-in entry -> 'never signed in'
$orphanStale = $staleness['60000000-0000-0000-0000-000000000002']
if (-not $orphanStale.isStale) { throw 'expected the orphaned app-only registration to be flagged stale (never signed in)' }
if ($orphanStale.reasons -notcontains 'never signed in') { throw "expected 'never signed in' reason, got: $($orphanStale.reasons -join ', ')" }
#managed identity is never flagged from sign-in data
$miStale = $staleness['10000000-0000-0000-0000-000000000003']
if ($miStale.signInAvailable) { throw 'managed identity should be marked signInAvailable=false (not covered by the sign-in report)' }
#the stale node carries metadata for the map
$staleNode = $mapData.nodes | Where-Object { $_.m.stale } | Select-Object -First 1
if (-not $staleNode) { throw 'expected at least one stale node on the map' }
if ($mapData.stats.staleNodeCount -lt 1) { throw 'expected stats.staleNodeCount >= 1' }
if ($mapData.stats.addedNodeCount -ne 1) { throw "expected one added node, got $($mapData.stats.addedNodeCount)" }
if ($mapData.stats.changedNodeCount -ne 1) { throw "expected one changed node, got $($mapData.stats.changedNodeCount)" }
if ($mapData.stats.removedNodeCount -ne 1) { throw "expected one removed node, got $($mapData.stats.removedNodeCount)" }
$removedNode = $mapData.nodes | Where-Object { $_.m.change -eq 'removed' } | Select-Object -First 1
if (-not $removedNode) { throw 'expected a removed ghost node in map data' }
Write-Host "Stale identity candidates on map: $($mapData.stats.staleNodeCount)"
Write-Host 'Sanity checks passed'

$mapDataJson = ($mapData | ConvertTo-Json -Depth 6 -Compress) -replace '</', '<\/'

$css = Get-Content -Raw (Join-Path $repoRoot 'pwsh' 'assets' 'azadspi.css')
$reportJs = Get-Content -Raw (Join-Path $repoRoot 'pwsh' 'assets' 'azadspi-report.js')
$mapJs = Get-Content -Raw (Join-Path $repoRoot 'pwsh' 'assets' 'azadspi-map.js')

$html = [System.Text.StringBuilder]::new()
[void]$html.AppendLine(@'
<!doctype html>
<html lang="en" style="height: 100%">
<head>
    <meta charset="utf-8" />
    <title>AzADServicePrincipalInsights - sample report</title>
    <script>
        (function () { try { var t = localStorage.getItem('azadspiTheme'); if (t === 'dark' || t === 'light') { document.documentElement.setAttribute('data-theme', t); } } catch (e) { } })();
    </script>
    <style>
'@)
[void]$html.AppendLine($css)
[void]$html.AppendLine(@'
    </style>
</head>
<body>
    <div class="summprnt" id="summprnt">
    <div class="summary" id="summary"><p class="pbordered">Microsoft Entra ID Service Principal Insights (sample report)</p>
    <section id="identityMap" class="mapSection">
        <header class="mapHeader">
            <h2>Permission Map</h2>
            <span class="mapSubtitle">Users, apps and their permissions - click a node to explore its connections</span>
            <div class="mapStats">
'@)
[void]$html.AppendLine("                <span class=`"mapStatChip`"><b>$($mapData.stats.nodeCount)</b> nodes</span><span class=`"mapStatChip`"><b>$($mapData.stats.edgeCount)</b> connections</span><span class=`"mapStatChip`"><span class=`"dotCritical`"></span><b>$($mapData.stats.criticalNodeCount)</b> critical</span><span class=`"mapStatChip`"><span class=`"dotMedium`"></span><b>$($mapData.stats.mediumNodeCount)</b> medium</span><span class=`"mapStatChip`"><b>$($mapData.stats.staleNodeCount)</b> stale</span><span class=`"mapStatChip mapStatChange`"><b>$($mapData.stats.addedNodeCount + $mapData.stats.changedNodeCount + $mapData.stats.removedNodeCount)</b> changes</span>")
[void]$html.AppendLine(@'
            </div>
        </header>
        <div class="mapToolbar">
            <div class="mapSearchWrap">
                <input id="mapSearch" type="search" placeholder="Search users, apps, permissions…" autocomplete="off" />
                <div class="mapSearchResults" id="mapSearchResults"></div>
            </div>
            <div class="mapFilters" id="mapFilters"></div>
            <div class="mapButtons">
                <button type="button" class="mapBtn" id="mapBtnZoomIn" title="Zoom in">+</button>
                <button type="button" class="mapBtn" id="mapBtnZoomOut" title="Zoom out">&#8722;</button>
                <button type="button" class="mapBtn" id="mapBtnFit" title="Fit to view">Fit</button>
                <button type="button" class="mapBtn" id="mapBtnLayout" title="Re-run layout">Layout</button>
                <button type="button" class="mapBtn" id="mapBtnFullscreen" title="Fullscreen">&#x26F6;</button>
            </div>
        </div>
        <div class="mapStage">
            <canvas id="mapCanvas"></canvas>
            <div class="mapLegend" id="mapLegend"></div>
            <div class="mapTooltip"></div>
            <aside class="mapDetails" id="mapDetails"></aside>
        </div>
    </section>
'@)
[void]$html.Append('<script id="azadspiMapData" type="application/json">')
[void]$html.Append($mapDataJson)
[void]$html.AppendLine('</script>')
[void]$html.AppendLine('    </div><!--summary-->')
[void]$html.AppendLine('    </div><!--summprnt-->')
[void]$html.AppendLine('<script>')
[void]$html.AppendLine($reportJs)
[void]$html.AppendLine('</script>')
[void]$html.AppendLine('<script>')
[void]$html.AppendLine($mapJs)
[void]$html.AppendLine('</script>')
[void]$html.AppendLine('</body>')
[void]$html.AppendLine('</html>')

$html.ToString() | Set-Content -Path $OutputFile -Encoding utf8 -Force
Write-Host "Sample report written to $OutputFile"
