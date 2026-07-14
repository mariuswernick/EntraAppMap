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

$cu = Get-Content -Raw (Join-Path $PSScriptRoot 'sample-cu.json') | ConvertFrom-Json

$mapData = Build-AzADSPIMapData -cu $cu -IncludeUnclassifiedPermissions:$IncludeUnclassifiedPermissions
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
[void]$html.AppendLine("                <span class=`"mapStatChip`"><b>$($mapData.stats.nodeCount)</b> nodes</span><span class=`"mapStatChip`"><b>$($mapData.stats.edgeCount)</b> connections</span><span class=`"mapStatChip`"><span class=`"dotCritical`"></span><b>$($mapData.stats.criticalNodeCount)</b> critical</span><span class=`"mapStatChip`"><span class=`"dotMedium`"></span><b>$($mapData.stats.mediumNodeCount)</b> medium</span>")
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
