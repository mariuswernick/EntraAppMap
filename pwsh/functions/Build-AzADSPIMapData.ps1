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

    .PARAMETER AgentSponsorsAvailable
    False when the sponsor API could not be queried. In that case sponsor state is reported as unknown and
    identities are not incorrectly flagged as sponsorless.

    .PARAMETER Staleness
    Hashtable keyed by object id with stale identity verdicts (from Get-AzADSPIStaleIdentity). Stale
    identities are marked on their node (m.stale, m.staleReasons, m.lastSignIn) and get at least medium risk.

    .PARAMETER ChangeState
    Hashtable keyed by object id with an 'added' or 'changed' value. The value is copied to m.change
    so the map and findings workspace can show the delta from a previous JSON state directory.

    .PARAMETER ChangeFields
    Hashtable keyed by object id with the changed top-level collection/property names.

    .PARAMETER RemovedStateCount
    Number of identities present in the previous JSON state but absent from the current collection.

    .PARAMETER RemovedIdentities
    Optional summaries of removed identities. These are emitted as non-connected ghost nodes with m.change='removed'.
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
        $AgentSponsors = @{},

        [bool]
        $AgentSponsorsAvailable = $true,

        [hashtable]
        $Staleness = @{},

        [hashtable]
        $ChangeState = @{},

        [hashtable]
        $ChangeFields = @{},

        [int]
        $RemovedStateCount = 0,

        [array]
        $RemovedIdentities = @()
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
            elseif ($AgentSponsorsAvailable) {
                #an agent identity without an accountable human is a governance gap
                $meta.noSponsor = $true
                $nodeRisk = riskMax $nodeRisk 'medium'
            }
            else { $meta.sponsorsUnavailable = $true }
        }
        #stale identity verdict
        if ($Staleness.ContainsKey([string]$entry.ObjectId)) {
            $staleVerdict = $Staleness[[string]$entry.ObjectId]
            if ($staleVerdict.lastSignIn) { $meta.lastSignIn = $staleVerdict.lastSignIn }
            if ($staleVerdict.isStale) {
                $meta.stale = $true
                $meta.staleReasons = @($staleVerdict.reasons)
                $nodeRisk = riskMax $nodeRisk 'medium'
            }
        }
        if ($ChangeState.ContainsKey([string]$entry.ObjectId)) {
            $meta.change = [string]$ChangeState[[string]$entry.ObjectId]
            if ($ChangeFields.ContainsKey([string]$entry.ObjectId)) {
                $meta.changeFields = @($ChangeFields[[string]$entry.ObjectId])
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

        #region Azure RBAC role assignments (Azure resource scopes)
        if ($entry.PSObject.Properties['SPAzureRoleAssignments'] -and $entry.SPAzureRoleAssignments) {
            foreach ($azRa in $entry.SPAzureRoleAssignments) {
                if (-not $azRa.roleAssignmentAssignmentScopeId) { continue }
                #by default only surface critical (privileged) Azure roles as nodes to keep the map readable
                $azRoleIsCritical = [bool]$azRa.roleIsCritical
                if (-not $azRoleIsCritical -and -not $IncludeUnclassifiedPermissions) { continue }

                $scopeId = [string]$azRa.roleAssignmentAssignmentScopeId
                $scopeName = $azRa.roleAssignmentAssignmentScopeName
                if (-not $scopeName) { $scopeName = $scopeId }
                #scope kind from the scope id shape (MG / subscription / RG / resource)
                $scopeKind = 'Resource'
                if ($scopeId -match '/managementGroups/') { $scopeKind = 'Management Group' }
                elseif ($scopeId -match '^/subscriptions/[^/]+$') { $scopeKind = 'Subscription' }
                elseif ($scopeId -match '/resourceGroups/[^/]+$') { $scopeKind = 'Resource Group' }
                elseif ($scopeId -match '/subscriptions/') { $scopeKind = 'Resource' }

                $azScopeNodeId = "azscope|$($scopeId)"
                addMapNode -id $azScopeNodeId -t 'azScope' -l $scopeName -sub "Azure scope · $($scopeKind)" -r $null -m ([ordered]@{
                        scopeId = $scopeId
                        scopeKind = $scopeKind
                    }) -stub
                $azEdgeRisk = $null
                if ($azRoleIsCritical) { $azEdgeRisk = 'critical' }
                $azEdgeLabel = $azRa.roleName
                if ($azRa.roleAssignmentApplicability -eq 'indirect') { $azEdgeLabel = "$($azRa.roleName) (inherited)" }
                addMapEdge -s $nodeId -d $azScopeNodeId -k 'azRole' -l $azEdgeLabel -r $azEdgeRisk
                #a critical (privileged) Azure role elevates the identity node's risk (node already added above)
                if ($azRoleIsCritical -and $htNodes.ContainsKey($nodeId)) { $htNodes[$nodeId].r = riskMax $htNodes[$nodeId].r 'critical' }
            }
        }
        #endregion Azure RBAC role assignments

        #region Federated identity credentials (external issuers that can impersonate this app)
        $ficSource = $null
        if ($entry.PSObject.Properties['APPFederatedIdentityCredentials'] -and $entry.APPFederatedIdentityCredentials) { $ficSource = @($entry.APPFederatedIdentityCredentials) }
        elseif ($entry.PSObject.Properties['ManagedIdentityFederatedIdentityCredentials'] -and $entry.ManagedIdentityFederatedIdentityCredentials) { $ficSource = @($entry.ManagedIdentityFederatedIdentityCredentials) }
        if ($ficSource) {
            foreach ($fic in $ficSource) {
                if (-not $fic.issuer) { continue }
                #node per (issuer, subject) - that pair is the trust relationship that can mint tokens for the app
                $ficIssuer = [string]$fic.issuer
                $ficSubject = [string]$fic.subject
                $ficNodeId = "fic|$($ficIssuer)|$($ficSubject)"
                #short label: host of the issuer + subject tail (e.g. token.actions.githubusercontent.com → repo:org/repo:ref)
                $ficLabel = $ficIssuer -replace '^https?://', ''
                if ($ficSubject) { $ficLabel = "$($ficLabel) · $($ficSubject)" }
                if ($ficLabel.Length -gt 60) { $ficLabel = $ficLabel.Substring(0, 59) + '…' }
                addMapNode -id $ficNodeId -t 'fic' -l $ficLabel -sub 'Federated credential (external issuer)' -r 'medium' -m ([ordered]@{
                        issuer = $ficIssuer
                        subject = $ficSubject
                        name = $fic.name
                        audiences = ($fic.audiences -join ', ')
                    })
                #edge points issuer -> app: the external identity can obtain tokens AS the app
                addMapEdge -s $ficNodeId -d $nodeId -k 'canImpersonate' -l 'federated' -r 'medium'
            }
        }
        #endregion Federated identity credentials
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

    foreach ($removedIdentity in $RemovedIdentities) {
        if (-not $removedIdentity.objectId) { continue }
        $removedType = switch -Wildcard ([string]$removedIdentity.objectType) {
            'SP MI*' { 'mi'; break }
            'SP Agent Blueprint' { 'agentBp'; break }
            'SP Agent*' { 'agent'; break }
            'SP APP EXT' { 'appExt'; break }
            'SP EXT' { 'appExt'; break }
            default { 'app' }
        }
        $removedMeta = [ordered]@{
            objectId = [string]$removedIdentity.objectId
            objectType = [string]$removedIdentity.objectType
            change = 'removed'
            removed = $true
        }
        if ($removedIdentity.appId) { $removedMeta.appId = [string]$removedIdentity.appId }
        addMapNode -id "sp|$($removedIdentity.objectId)" -t $removedType -l ([string]$removedIdentity.label) -sub "Removed · $($removedIdentity.objectType)" -r $null -m $removedMeta
    }

    #stats for the map header
    $typeCounts = @{}
    $criticalNodeCount = 0
    $mediumNodeCount = 0
    $staleNodeCount = 0
    $addedNodeCount = 0
    $changedNodeCount = 0
    foreach ($node in $htNodes.Values) {
        if (-not $typeCounts.ContainsKey($node.t)) { $typeCounts[$node.t] = 0 }
        $typeCounts[$node.t] = $typeCounts[$node.t] + 1
        if ($node.r -eq 'critical') { $criticalNodeCount++ }
        elseif ($node.r -eq 'medium') { $mediumNodeCount++ }
        if ($node.m -and $node.m.stale) { $staleNodeCount++ }
        if ($node.m -and $node.m.change -eq 'added') { $addedNodeCount++ }
        elseif ($node.m -and $node.m.change -eq 'changed') { $changedNodeCount++ }
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
            staleNodeCount = $staleNodeCount
            addedNodeCount = $addedNodeCount
            changedNodeCount = $changedNodeCount
            removedNodeCount = $RemovedStateCount
            includesUnclassifiedPermissionNodes = [bool]$IncludeUnclassifiedPermissions
        }
    }
}
