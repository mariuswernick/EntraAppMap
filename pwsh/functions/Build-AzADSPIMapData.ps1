function Build-AzADSPIMapData {
    <#
    .SYNOPSIS
    Builds the node/edge dataset for the interactive Permission Map from the enriched Service Principal collection ($cu).

    .DESCRIPTION
    Pure transformation - no API calls. Consumes the $cu ArrayList that is populated during data collection and
    returns a PSCustomObject with 'nodes', 'edges' and 'stats' that is serialized to JSON and embedded in the HTML report.

    Node schema : id, t (type), l (label), sub (subtitle), r (risk: critical|medium|$null), m (metadata for the details panel)
    Node types  : app (SP+App internal), appExt (external/multi-tenant SP), mi (managed identity),
                  agent (Entra Agent ID agent identity), agentBp (agent identity blueprint principal),
                  user, guest, group, resource (permission target API without own $cu entry),
                  permApp (application permission), permDel (delegated permission), role (Entra directory role)
    Edge schema : s (source node id), d (target node id), k (kind), l (optional label), r (risk)
    Edge kinds  : owns, permApp, permDel, onApi, usesApi, assignedTo, memberOf, aadRole, sponsors, instanceOf

    .PARAMETER cu
    The enriched collection built during data collection.

    .PARAMETER IncludeUnclassifiedPermissions
    By default only classified (critical/medium) permissions become dedicated permission nodes; unclassified
    permissions are aggregated into a single 'usesApi' edge per SP/API pair to keep the map readable.
    This switch creates dedicated nodes for unclassified permissions as well.

    .PARAMETER AssignedToEdgeLimit
    Per Service Principal cap for 'user/group assigned to app' edges (some apps have thousands of assignments).
    The real count is always available in the details panel.

    .PARAMETER AgentSponsors
    Hashtable keyed by agent identity object id; values are lists of @{ id; displayName; type } sponsor entries
    (the humans accountable for an agent identity). Agent identities without a sponsor are flagged.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        $cu,

        [switch]
        $IncludeUnclassifiedPermissions,

        [int]
        $AssignedToEdgeLimit = 200,

        [hashtable]
        $AgentSponsors = @{}
    )

    $htNodes = @{}
    $htNodeIsStub = @{}
    $edges = [System.Collections.ArrayList]@()
    $htEdgeDedupe = @{}
    $htAppIdToNodeId = @{}
    $pendingBlueprintLinks = [System.Collections.ArrayList]@()

    #region helpers
    function addMapNode {
        param($id, $t, $l, $sub, $r, $m, [switch]$stub)
        if ([string]::IsNullOrEmpty($id)) { return }
        if ($htNodes.ContainsKey($id)) {
            #a full node never gets replaced; a stub gets upgraded by a full node
            if ($htNodeIsStub.ContainsKey($id) -and -not $stub) {
                $htNodes[$id] = [PSCustomObject]@{ id = $id; t = $t; l = $l; sub = $sub; r = $r; m = $m }
                $htNodeIsStub.Remove($id)
            }
            return
        }
        $htNodes[$id] = [PSCustomObject]@{ id = $id; t = $t; l = $l; sub = $sub; r = $r; m = $m }
        if ($stub) { $htNodeIsStub[$id] = $true }
    }

    function addMapEdge {
        param($s, $d, $k, $l, $r)
        if ([string]::IsNullOrEmpty($s) -or [string]::IsNullOrEmpty($d)) { return }
        if ($s -eq $d) { return }
        $dedupeKey = "$($s)>$($d)>$($k)>$($l)"
        if ($htEdgeDedupe.ContainsKey($dedupeKey)) { return }
        $htEdgeDedupe[$dedupeKey] = $true
        $edge = [ordered]@{ s = $s; d = $d; k = $k }
        if (-not [string]::IsNullOrEmpty($l)) { $edge.l = $l }
        if (-not [string]::IsNullOrEmpty($r) -and $r -ne 'unclassified') { $edge.r = $r }
        $null = $edges.Add([PSCustomObject]$edge)
    }

    function resolvePrincipalNodeType {
        param($principalType)
        if ($principalType -like '*Guest*') { return 'guest' }
        if ($principalType -like '*User*') { return 'user' }
        if ($principalType -eq 'Group') { return 'group' }
        return 'app'
    }

    function riskMax {
        param($a, $b)
        if ($a -eq 'critical' -or $b -eq 'critical') { return 'critical' }
        if ($a -eq 'medium' -or $b -eq 'medium') { return 'medium' }
        if ($a) { return $a }
        return $b
    }
    #endregion helpers

    foreach ($entryRaw in $cu) {
        #managed identity entries are added to $cu wrapped in a one-element ArrayList - normalize
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

        $nodeId = "sp|$($entry.ObjectId)"

        #node type from ObjectType discriminator
        switch -Wildcard ($objectType) {
            'SP MI*' { $nodeType = 'mi'; break }
            'SP Agent Blueprint' { $nodeType = 'agentBp'; break }
            'SP Agent*' { $nodeType = 'agent'; break }
            'SP APP EXT' { $nodeType = 'appExt'; break }
            'SP EXT' { $nodeType = 'appExt'; break }
            'SP APP INT' { $nodeType = 'app'; break }
            'APP*' { $nodeType = 'app'; break }
            default { $nodeType = 'app' }
        }

        $label = $null
        if ($sp) { $label = $sp.SPDisplayName }
        if (-not $label -and $app) { $label = $app.APPDisplayName }
        if (-not $label) { $label = $entry.ObjectId }

        #region node metadata + risk rollup
        $nodeRisk = $null
        $meta = [ordered]@{
            objectId = $entry.ObjectId
            objectType = $objectType
        }
        if ($sp) {
            $meta.appId = $sp.SPAppId
            $meta.spType = $sp.SPServicePrincipalType
            $meta.accountEnabled = $sp.SPAccountEnabled
            $meta.createdDateTime = $sp.SPCreatedDateTime
            $meta.orgId = $sp.SPAppOwnerOrganizationId
        }
        elseif ($app) {
            $meta.appId = $app.APPAppClientId
            $meta.createdDateTime = $app.APPCreatedDateTime
        }
        if ($app -and $app.APPSignInAudience) { $meta.signInAudience = $app.APPSignInAudience }

        $appPermCritical = 0; $appPermMedium = 0; $appPermUnclassified = 0
        if ($entry.PSObject.Properties['SPAppRoleAssignments'] -and $entry.SPAppRoleAssignments) {
            foreach ($ara in $entry.SPAppRoleAssignments) {
                switch ($ara.AppRolePermissionSensitivity) {
                    'critical' { $appPermCritical++; $nodeRisk = riskMax $nodeRisk 'critical' }
                    'medium' { $appPermMedium++; $nodeRisk = riskMax $nodeRisk 'medium' }
                    default { $appPermUnclassified++ }
                }
            }
        }
        $delPermCritical = 0; $delPermMedium = 0; $delPermUnclassified = 0
        if ($entry.PSObject.Properties['SPOauth2PermissionGrants'] -and $entry.SPOauth2PermissionGrants) {
            foreach ($grant in $entry.SPOauth2PermissionGrants) {
                switch ($grant.permissionSensitivity) {
                    'critical' { $delPermCritical++; $nodeRisk = riskMax $nodeRisk 'critical' }
                    'medium' { $delPermMedium++; $nodeRisk = riskMax $nodeRisk 'medium' }
                    default { $delPermUnclassified++ }
                }
            }
        }
        $meta.appPermissions = @{ critical = $appPermCritical; medium = $appPermMedium; unclassified = $appPermUnclassified }
        $meta.delegatedPermissions = @{ critical = $delPermCritical; medium = $delPermMedium; unclassified = $delPermUnclassified }

        $aadRoles = [System.Collections.ArrayList]@()
        if ($entry.PSObject.Properties['SPAADRoleAssignments'] -and $entry.SPAADRoleAssignments) {
            foreach ($ra in $entry.SPAADRoleAssignments) {
                $null = $aadRoles.Add(@{ name = $ra.roleDefinitionName; critical = [bool]$ra.roleIsCritical })
                if ($ra.roleIsCritical) { $nodeRisk = riskMax $nodeRisk 'critical' }
            }
        }
        if ($aadRoles.Count -gt 0) { $meta.aadRoles = $aadRoles }

        if ($entry.PSObject.Properties['SPAzureRoleAssignments'] -and $entry.SPAzureRoleAssignments) {
            $meta.azureRoleCount = @($entry.SPAzureRoleAssignments).Count
        }
        if ($entry.PSObject.Properties['SPAppRoleAssignedTo'] -and $entry.SPAppRoleAssignedTo) {
            $meta.assignedToCount = @($entry.SPAppRoleAssignedTo).Count
        }
        if ($entry.PSObject.Properties['SPOwners'] -and $entry.SPOwners) {
            $meta.spOwnerCount = @($entry.SPOwners).Count
        }
        if ($entry.PSObject.Properties['APPAppOwners'] -and $entry.APPAppOwners) {
            $meta.appOwnerCount = @($entry.APPAppOwners).Count
        }
        if ($entry.PSObject.Properties['APPPasswordCredentials'] -and $entry.APPPasswordCredentials) {
            $meta.secretCount = @($entry.APPPasswordCredentials).Count
        }
        if ($entry.PSObject.Properties['APPKeyCredentials'] -and $entry.APPKeyCredentials) {
            $meta.certCount = @($entry.APPKeyCredentials).Count
        }
        if ($entry.PSObject.Properties['APPFederatedIdentityCredentials'] -and $entry.APPFederatedIdentityCredentials) {
            $meta.federatedCredentialCount = @($entry.APPFederatedIdentityCredentials).Count
        }
        if ($entry.PSObject.Properties['ManagedIdentity'] -and $entry.ManagedIdentity) {
            $mi = @($entry.ManagedIdentity)[0]
            if ($mi) {
                $meta.miResourceType = $mi.resourceType
                $meta.miResourceScope = $mi.resourceScope
            }
        }
        if ($nodeType -eq 'agent') {
            if ($sp -and $sp.SPAgentBlueprintId) { $meta.blueprintId = $sp.SPAgentBlueprintId }
            $agentSponsorList = $null
            if ($AgentSponsors.ContainsKey([string]$entry.ObjectId)) { $agentSponsorList = $AgentSponsors[[string]$entry.ObjectId] }
            if ($agentSponsorList) {
                $meta.sponsors = @(foreach ($sponsorEntry in $agentSponsorList) { @{ name = $sponsorEntry.displayName; type = $sponsorEntry.type } })
            }
            else {
                #an agent identity without an accountable human is a governance gap
                $meta.noSponsor = $true
                $nodeRisk = riskMax $nodeRisk 'medium'
            }
        }
        #endregion node metadata + risk rollup

        addMapNode -id $nodeId -t $nodeType -l $label -sub $objectType -r $nodeRisk -m $meta
        if ($sp -and $sp.SPAppId) { $htAppIdToNodeId[[string]$sp.SPAppId] = $nodeId }

        #region agent relationships (blueprint + sponsors)
        if ($nodeType -eq 'agent') {
            if ($sp -and $sp.SPAgentBlueprintId) {
                $null = $pendingBlueprintLinks.Add(@{ agentNodeId = $nodeId; blueprintAppId = [string]$sp.SPAgentBlueprintId })
            }
            if ($AgentSponsors.ContainsKey([string]$entry.ObjectId)) {
                foreach ($sponsorEntry in $AgentSponsors[[string]$entry.ObjectId]) {
                    if (-not $sponsorEntry.id) { continue }
                    if ($sponsorEntry.type -eq 'group') {
                        $sponsorNodeId = "group|$($sponsorEntry.id)"
                        addMapNode -id $sponsorNodeId -t 'group' -l $sponsorEntry.displayName -sub 'Group' -r $null -m ([ordered]@{ objectId = $sponsorEntry.id }) -stub
                    }
                    else {
                        $sponsorNodeId = "user|$($sponsorEntry.id)"
                        addMapNode -id $sponsorNodeId -t 'user' -l $sponsorEntry.displayName -sub 'User (sponsor)' -r $null -m ([ordered]@{ objectId = $sponsorEntry.id }) -stub
                    }
                    addMapEdge -s $sponsorNodeId -d $nodeId -k 'sponsors'
                }
            }
        }
        #endregion agent relationships (blueprint + sponsors)

        #region owners
        $ownerSources = @()
        if ($entry.PSObject.Properties['SPOwners'] -and $entry.SPOwners) { $ownerSources += @($entry.SPOwners) }
        if ($entry.PSObject.Properties['APPAppOwners'] -and $entry.APPAppOwners) { $ownerSources += @($entry.APPAppOwners) }
        foreach ($owner in $ownerSources) {
            if (-not $owner.id) { continue }
            $ownerType = resolvePrincipalNodeType -principalType $owner.principalType
            if ($ownerType -eq 'user' -or $ownerType -eq 'guest') {
                $ownerNodeId = "user|$($owner.id)"
                addMapNode -id $ownerNodeId -t $ownerType -l $owner.displayName -sub $owner.principalType -r $null -m ([ordered]@{ objectId = $owner.id; principalType = $owner.principalType }) -stub
            }
            else {
                $ownerNodeId = "sp|$($owner.id)"
                addMapNode -id $ownerNodeId -t 'app' -l $owner.displayName -sub $owner.principalType -r $null -m ([ordered]@{ objectId = $owner.id; principalType = $owner.principalType }) -stub
            }
            addMapEdge -s $ownerNodeId -d $nodeId -k 'owns'
        }
        #endregion owners

        #region application permissions (app roles held by this SP)
        if ($entry.PSObject.Properties['SPAppRoleAssignments'] -and $entry.SPAppRoleAssignments) {
            foreach ($ara in $entry.SPAppRoleAssignments) {
                $resourceNodeId = "sp|$($ara.AppRoleAssignmentResourceId)"
                addMapNode -id $resourceNodeId -t 'resource' -l $ara.AppRoleAssignmentResourceDisplayName -sub 'Resource API' -r $null -m ([ordered]@{ objectId = $ara.AppRoleAssignmentResourceId }) -stub

                $sensitivity = $ara.AppRolePermissionSensitivity
                $isClassified = $sensitivity -eq 'critical' -or $sensitivity -eq 'medium'
                if ($isClassified -or $IncludeUnclassifiedPermissions) {
                    $permNodeId = "permA|$($ara.AppRoleAssignmentResourceId)|$($ara.AppRolePermission)"
                    $permRisk = $null
                    if ($isClassified) { $permRisk = $sensitivity }
                    addMapNode -id $permNodeId -t 'permApp' -l $ara.AppRolePermission -sub "Application permission · $($ara.AppRoleAssignmentResourceDisplayName)" -r $permRisk -m ([ordered]@{
                            resource = $ara.AppRoleAssignmentResourceDisplayName
                            displayName = $ara.AppRoleDisplayName
                            description = $ara.AppRoleDescription
                            classification = $sensitivity
                        })
                    addMapEdge -s $nodeId -d $permNodeId -k 'permApp' -r $permRisk
                    addMapEdge -s $permNodeId -d $resourceNodeId -k 'onApi'
                }
                else {
                    addMapEdge -s $nodeId -d $resourceNodeId -k 'usesApi'
                }
            }
        }
        #endregion application permissions

        #region delegated permissions (oauth2 grants held by this SP)
        if ($entry.PSObject.Properties['SPOauth2PermissionGrants'] -and $entry.SPOauth2PermissionGrants) {
            foreach ($grant in $entry.SPOauth2PermissionGrants) {
                $resourceNodeId = "sp|$($grant.SPId)"
                addMapNode -id $resourceNodeId -t 'resource' -l $grant.SPDisplayName -sub 'Resource API' -r $null -m ([ordered]@{ objectId = $grant.SPId }) -stub

                $sensitivity = $grant.permissionSensitivity
                $isClassified = $sensitivity -eq 'critical' -or $sensitivity -eq 'medium'
                if ($isClassified -or $IncludeUnclassifiedPermissions) {
                    $permNodeId = "permD|$($grant.SPId)|$($grant.permission)"
                    $permRisk = $null
                    if ($isClassified) { $permRisk = $sensitivity }
                    addMapNode -id $permNodeId -t 'permDel' -l $grant.permission -sub "Delegated permission · $($grant.SPDisplayName)" -r $permRisk -m ([ordered]@{
                            resource = $grant.SPDisplayName
                            displayName = $grant.adminConsentDisplayName
                            description = $grant.adminConsentDescription
                            classification = $sensitivity
                        })
                    addMapEdge -s $nodeId -d $permNodeId -k 'permDel' -l $grant.type -r $permRisk
                    addMapEdge -s $permNodeId -d $resourceNodeId -k 'onApi'
                }
                else {
                    addMapEdge -s $nodeId -d $resourceNodeId -k 'usesApi'
                }
            }
        }
        #endregion delegated permissions

        #region users/groups assigned to this SP's app roles
        if ($entry.PSObject.Properties['SPAppRoleAssignedTo'] -and $entry.SPAppRoleAssignedTo) {
            $assignedCounter = 0
            foreach ($assignee in $entry.SPAppRoleAssignedTo) {
                if ($assignedCounter -ge $AssignedToEdgeLimit) { break }
                if (-not $assignee.principalId) { continue }
                $assigneeType = resolvePrincipalNodeType -principalType $assignee.principalType
                if ($assigneeType -eq 'app') {
                    $assigneeNodeId = "sp|$($assignee.principalId)"
                    addMapNode -id $assigneeNodeId -t 'app' -l $assignee.principalDisplayName -sub $assignee.principalType -r $null -m ([ordered]@{ objectId = $assignee.principalId; principalType = $assignee.principalType }) -stub
                }
                elseif ($assigneeType -eq 'group') {
                    $assigneeNodeId = "group|$($assignee.principalId)"
                    addMapNode -id $assigneeNodeId -t 'group' -l $assignee.principalDisplayName -sub 'Group' -r $null -m ([ordered]@{ objectId = $assignee.principalId }) -stub
                }
                else {
                    $assigneeNodeId = "user|$($assignee.principalId)"
                    addMapNode -id $assigneeNodeId -t $assigneeType -l $assignee.principalDisplayName -sub $assignee.principalType -r $null -m ([ordered]@{ objectId = $assignee.principalId; principalType = $assignee.principalType }) -stub
                }
                $roleLabel = $assignee.roleValue
                if (-not $roleLabel) { $roleLabel = $assignee.roleDisplayName }
                addMapEdge -s $assigneeNodeId -d $nodeId -k 'assignedTo' -l $roleLabel
                $assignedCounter++
            }
        }
        #endregion users/groups assigned to this SP's app roles

        #region group memberships of this SP
        if ($entry.PSObject.Properties['SPGroupMemberships'] -and $entry.SPGroupMemberships) {
            foreach ($membership in $entry.SPGroupMemberships) {
                if (-not $membership.ObjectId) { continue }
                $groupNodeId = "group|$($membership.ObjectId)"
                addMapNode -id $groupNodeId -t 'group' -l $membership.DisplayName -sub 'Group' -r $null -m ([ordered]@{ objectId = $membership.ObjectId }) -stub
                addMapEdge -s $nodeId -d $groupNodeId -k 'memberOf'
            }
        }
        #endregion group memberships of this SP

        #region Entra directory roles
        if ($entry.PSObject.Properties['SPAADRoleAssignments'] -and $entry.SPAADRoleAssignments) {
            foreach ($ra in $entry.SPAADRoleAssignments) {
                if (-not $ra.roleDefinitionId) { continue }
                $roleNodeId = "role|$($ra.roleDefinitionId)"
                $roleRisk = $null
                if ($ra.roleIsCritical) { $roleRisk = 'critical' }
                addMapNode -id $roleNodeId -t 'role' -l $ra.roleDefinitionName -sub 'Entra ID directory role' -r $roleRisk -m ([ordered]@{
                        roleDefinitionId = $ra.roleDefinitionId
                        description = $ra.roleDefinitionDescription
                        roleType = $ra.roleType
                        critical = [bool]$ra.roleIsCritical
                    })
                addMapEdge -s $nodeId -d $roleNodeId -k 'aadRole' -r $roleRisk
            }
        }
        #endregion Entra directory roles
    }

    #resolve agent -> blueprint links (the blueprint principal SP shares the blueprint's appId)
    foreach ($blueprintLink in $pendingBlueprintLinks) {
        $blueprintNodeId = $htAppIdToNodeId[$blueprintLink.blueprintAppId]
        if (-not $blueprintNodeId) {
            $blueprintNodeId = "bp|$($blueprintLink.blueprintAppId)"
            addMapNode -id $blueprintNodeId -t 'agentBp' -l "Blueprint $($blueprintLink.blueprintAppId)" -sub 'Agent identity blueprint' -r $null -m ([ordered]@{ appId = $blueprintLink.blueprintAppId }) -stub
        }
        addMapEdge -s $blueprintLink.agentNodeId -d $blueprintNodeId -k 'instanceOf'
    }

    #stats for the map header
    $typeCounts = @{}
    $criticalNodeCount = 0
    $mediumNodeCount = 0
    foreach ($node in $htNodes.Values) {
        if (-not $typeCounts.ContainsKey($node.t)) { $typeCounts[$node.t] = 0 }
        $typeCounts[$node.t] = $typeCounts[$node.t] + 1
        if ($node.r -eq 'critical') { $criticalNodeCount++ }
        elseif ($node.r -eq 'medium') { $mediumNodeCount++ }
    }

    return [PSCustomObject]@{
        nodes = @($htNodes.Values)
        edges = @($edges)
        stats = [PSCustomObject]@{
            nodeCount = $htNodes.Count
            edgeCount = $edges.Count
            typeCounts = $typeCounts
            criticalNodeCount = $criticalNodeCount
            mediumNodeCount = $mediumNodeCount
            includesUnclassifiedPermissionNodes = [bool]$IncludeUnclassifiedPermissions
        }
    }
}
