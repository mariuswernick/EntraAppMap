/* Sample dataset for offline development of the Permission Map.
   Produces the exact same schema as pwsh/functions/Build-AzADSPIMapData.ps1:
   { nodes: [{id,t,l,sub,r,m}], edges: [{s,d,k,l,r}], stats: {...} } */
(function () {
    'use strict';

    var nodes = [], edges = [];
    var nodeIds = {}, edgeKeys = {};

    function addNode(id, t, l, sub, r, m) {
        if (nodeIds[id]) { return; }
        nodeIds[id] = true;
        nodes.push({ id: id, t: t, l: l, sub: sub, r: r || null, m: m || { objectId: id.split('|').pop() } });
    }
    function addEdge(s, d, k, l, r) {
        var key = s + '>' + d + '>' + k + '>' + (l || '');
        if (edgeKeys[key]) { return; }
        edgeKeys[key] = true;
        var e = { s: s, d: d, k: k };
        if (l) { e.l = l; }
        if (r) { e.r = r; }
        edges.push(e);
    }
    function guid(n) {
        /* deterministic fake guids for readable sample data */
        var h = ('00000000' + n.toString(16)).slice(-8);
        return h + '-1111-2222-3333-' + ('000000000000' + n.toString(16)).slice(-12);
    }

    /* ---------------- resource APIs ---------------- */
    var RES = {
        graph: 'sp|' + guid(9001),
        sharepoint: 'sp|' + guid(9002),
        exchange: 'sp|' + guid(9003),
        keyvault: 'sp|' + guid(9004),
        arm: 'sp|' + guid(9005)
    };
    addNode(RES.graph, 'resource', 'Microsoft Graph', 'Resource API', null, { objectId: guid(9001), appId: '00000003-0000-0000-c000-000000000000' });
    addNode(RES.sharepoint, 'resource', 'Office 365 SharePoint Online', 'Resource API', null, { objectId: guid(9002) });
    addNode(RES.exchange, 'resource', 'Office 365 Exchange Online', 'Resource API', null, { objectId: guid(9003) });
    addNode(RES.keyvault, 'resource', 'Azure Key Vault', 'Resource API', null, { objectId: guid(9004) });
    addNode(RES.arm, 'resource', 'Azure Service Management', 'Resource API', null, { objectId: guid(9005) });

    /* ---------------- permissions ---------------- */
    function permApp(resKey, value, risk, desc) {
        var id = 'permA|' + RES[resKey].split('|')[1] + '|' + value;
        addNode(id, 'permApp', value, 'Application permission · ' + label(resKey), risk, {
            resource: label(resKey), displayName: desc, classification: risk || 'unclassified'
        });
        return id;
    }
    function permDel(resKey, value, risk, desc) {
        var id = 'permD|' + RES[resKey].split('|')[1] + '|' + value;
        addNode(id, 'permDel', value, 'Delegated permission · ' + label(resKey), risk, {
            resource: label(resKey), displayName: desc, classification: risk || 'unclassified'
        });
        return id;
    }
    function label(resKey) {
        return { graph: 'Microsoft Graph', sharepoint: 'Office 365 SharePoint Online', exchange: 'Office 365 Exchange Online', keyvault: 'Azure Key Vault', arm: 'Azure Service Management' }[resKey];
    }

    var P = {
        mailRW: permApp('graph', 'Mail.ReadWrite', 'critical', 'Read and write mail in all mailboxes'),
        mailSend: permApp('graph', 'Mail.Send', 'critical', 'Send mail as any user'),
        dirRWAll: permApp('graph', 'Directory.ReadWrite.All', 'critical', 'Read and write directory data'),
        appRWAll: permApp('graph', 'Application.ReadWrite.All', 'critical', 'Manage apps and app registrations'),
        roleMgmt: permApp('graph', 'RoleManagement.ReadWrite.Directory', 'critical', 'Manage role assignments'),
        sitesFull: permApp('sharepoint', 'Sites.FullControl.All', 'critical', 'Full control of all site collections'),
        dirReadAll: permApp('graph', 'Directory.Read.All', 'medium', 'Read directory data'),
        groupRWAll: permApp('graph', 'Group.ReadWrite.All', 'medium', 'Read and write all groups'),
        filesRWAll: permApp('graph', 'Files.ReadWrite.All', 'medium', 'Read and write files in all site collections'),
        exchFull: permApp('exchange', 'full_access_as_app', 'critical', 'Access all mailboxes as the app'),
        userReadAllDel: permDel('graph', 'User.Read.All', 'medium', 'Read all users’ full profiles'),
        mailSendDel: permDel('graph', 'Mail.Send', 'critical', 'Send mail as the signed-in user'),
        sitesRWDel: permDel('sharepoint', 'AllSites.Write', 'medium', 'Read and write items in all site collections')
    };

    /* ---------------- Entra directory roles ---------------- */
    var ROLE_GA = 'role|62e90394-69f5-4237-9190-012177145e10';
    var ROLE_APPADMIN = 'role|9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3';
    var ROLE_DIRREAD = 'role|88d8e3e3-8f55-4a1e-953a-9b9898b8876b';
    addNode(ROLE_GA, 'role', 'Global Administrator', 'Entra ID directory role', 'critical', { roleDefinitionId: '62e90394-69f5-4237-9190-012177145e10', roleType: 'BuiltIn', critical: true, description: 'Full access to all administrative features' });
    addNode(ROLE_APPADMIN, 'role', 'Application Administrator', 'Entra ID directory role', null, { roleDefinitionId: '9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3', roleType: 'BuiltIn', critical: false });
    addNode(ROLE_DIRREAD, 'role', 'Directory Readers', 'Entra ID directory role', null, { roleDefinitionId: '88d8e3e3-8f55-4a1e-953a-9b9898b8876b', roleType: 'BuiltIn', critical: false });

    /* ---------------- users & groups ---------------- */
    var firstNames = ['Ava', 'Ben', 'Chloe', 'David', 'Emma', 'Felix', 'Grace', 'Henry', 'Ida', 'Jonas', 'Klara', 'Liam', 'Mia', 'Noah', 'Olivia', 'Paul', 'Quinn', 'Rosa', 'Sam', 'Tara', 'Uma', 'Viktor', 'Wanda', 'Xavier'];
    var lastNames = ['Meyer', 'Schmidt', 'Nguyen', 'Garcia', 'Kowalski', 'Anders', 'Berger', 'Costa', 'Dietrich', 'Eriksen', 'Fischer', 'Gruber'];
    var users = [];
    for (var u = 0; u < 24; u++) {
        var isGuest = u >= 20;
        var uid = 'user|' + guid(100 + u);
        var name = firstNames[u % firstNames.length] + ' ' + lastNames[u % lastNames.length] + (isGuest ? ' (guest)' : '');
        addNode(uid, isGuest ? 'guest' : 'user', name, isGuest ? 'User (Guest)' : 'User (Member)', null, { objectId: guid(100 + u), principalType: isGuest ? 'User (Guest)' : 'User (Member)' });
        users.push(uid);
    }
    var GRP_IT = 'group|' + guid(300);
    var GRP_FIN = 'group|' + guid(301);
    var GRP_HR = 'group|' + guid(302);
    addNode(GRP_IT, 'group', 'SG-IT-Admins', 'Group', null, { objectId: guid(300) });
    addNode(GRP_FIN, 'group', 'SG-Finance', 'Group', null, { objectId: guid(301) });
    addNode(GRP_HR, 'group', 'SG-HR-App-Users', 'Group', null, { objectId: guid(302) });

    /* ---------------- apps / service principals ---------------- */
    function app(n, name, type, objectType, meta) {
        var id = 'sp|' + guid(500 + n);
        meta = meta || {};
        meta.objectId = guid(500 + n);
        meta.appId = guid(700 + n);
        meta.objectType = objectType;
        meta.accountEnabled = meta.accountEnabled !== false;
        meta.createdDateTime = '202' + (n % 5) + '-0' + (1 + n % 9) + '-15T09:00:00Z';
        addNode(id, type, name, objectType, null, meta);
        return id;
    }

    var hrSync = app(1, 'HR Sync Service', 'app', 'SP APP INT', { secretCount: 2, certCount: 1, change: 'changed' });
    var finPipe = app(2, 'Finance Data Pipeline', 'app', 'SP APP INT', { secretCount: 1 });
    var devops = app(3, 'DevOps Automation', 'app', 'SP APP INT', { federatedCredentialCount: 2 });
    var crm = app(4, 'Legacy CRM Connector', 'app', 'SP APP INT', { secretCount: 4 });
    var marketing = app(5, 'Marketing Analytics', 'app', 'SP APP INT', {});
    var backup = app(6, 'Backup Agent', 'app', 'SP APP INT', { certCount: 1 });
    var intranet = app(7, 'Intranet Portal', 'app', 'SP APP INT', {});
    var reporting = app(8, 'Reporting Dashboards', 'app', 'SP APP INT', {});
    var partner = app(9, 'Contoso Partner Portal', 'appExt', 'SP APP EXT', {});
    var adobe = app(10, 'Adobe Acrobat Sign', 'appExt', 'SP APP EXT', {});
    var salesforce = app(11, 'Salesforce Connector', 'appExt', 'SP APP EXT', {});
    var zoom = app(12, 'Zoom for Teams', 'appExt', 'SP EXT', {});
    var miAks = app(13, 'mi-aks-prod-westeu', 'mi', 'SP MI System assigned', { miResourceType: 'ContainerService/managedClusters', azureRoleCount: 3 });
    var miFunc = app(14, 'mi-funcapp-billing', 'mi', 'SP MI System assigned', { miResourceType: 'Web/sites', azureRoleCount: 2 });
    var miLogic = app(15, 'mi-logicapp-hr', 'mi', 'SP MI User assigned', { miResourceType: 'ManagedIdentity/userAssignedIdentities', azureRoleCount: 1 });
    var appOnly = app(16, 'Orphaned App Registration', 'app', 'APP AppOnly', { secretCount: 1, change: 'added' });

    /* Entra Agent ID: blueprint principal + agent identities */
    var agentBp = app(17, 'Copilot Studio Agent Blueprint', 'agentBp', 'SP Agent Blueprint', {});
    var agentBpAppId = guid(717);
    var agentHr = app(18, 'agent-hr-assistant', 'agent', 'SP Agent', { blueprintId: agentBpAppId });
    var agentSales = app(19, 'agent-sales-briefing', 'agent', 'SP Agent', { blueprintId: agentBpAppId });
    nodes.forEach(function (n) {
        if (n.id === agentHr) { n.m.sponsors = [{ name: 'Grace Berger', type: 'user' }]; }
        if (n.id === agentSales) { n.m.noSponsor = true; }
    });

    /* stale identity examples (mirrors Get-AzADSPIStaleIdentity output on node metadata) */
    function markStale(id, reasons, lastSignIn) {
        nodes.forEach(function (n) {
            if (n.id !== id) { return; }
            n.m.stale = true;
            n.m.staleReasons = reasons;
            if (lastSignIn) { n.m.lastSignIn = lastSignIn; }
            if (n.r !== 'critical') { n.r = 'medium'; }
        });
    }
    markStale(crm, ['no sign-in for 412 days', 'all 4 credential(s) expired'], '2024-05-28');
    markStale(marketing, ['never signed in'], null);
    markStale(reporting, ['account disabled', 'no sign-in for 190 days'], '2025-01-05');
    markStale(backup, ['all 1 credential(s) expired'], null);

    /* ---------------- Azure RBAC scopes (critical roles surface a scope node + azRole edge) ---------------- */
    function azScope(n, name, kind) {
        var id = 'azscope|/subscriptions/' + guid(800 + n);
        addNode(id, 'azScope', name, 'Azure scope · ' + kind, null, { scopeId: '/subscriptions/' + guid(800 + n), scopeKind: kind });
        return id;
    }
    var subProd = azScope(1, 'sub-prod-platform', 'Subscription');
    var mgRoot = azScope(2, 'Tenant Root Group', 'Management Group');
    var rgBilling = azScope(3, 'rg-billing', 'Resource Group');
    addEdge(devops, mgRoot, 'azRole', 'Owner', 'critical');       /* devops app = Owner at MG root = big blast radius */
    addEdge(miAks, subProd, 'azRole', 'Contributor', 'critical');
    addEdge(miFunc, rgBilling, 'azRole', 'Reader');              /* non-critical, shown because IncludeUnclassified in preview */
    setRisk(devops, 'critical');

    /* ---------------- Federated identity credentials (external issuers that can impersonate an app) ---------------- */
    function fic(issuer, subject, name) {
        var id = 'fic|' + issuer + '|' + subject;
        var label = issuer.replace(/^https?:\/\//, '') + ' · ' + subject;
        addNode(id, 'fic', label.length > 60 ? label.slice(0, 59) + '…' : label, 'Federated credential (external issuer)', 'medium',
            { issuer: issuer, subject: subject, name: name, audiences: 'api://AzureADTokenExchange' });
        return id;
    }
    var ficGithub = fic('https://token.actions.githubusercontent.com', 'repo:contoso/infra:ref:refs/heads/main', 'gh-deploy');
    var ficK8s = fic('https://oidc.prod-aks.azure.com/abc', 'system:serviceaccount:ns:deployer', 'aks-workload');
    addEdge(ficGithub, devops, 'canImpersonate', 'federated', 'medium');
    addEdge(ficK8s, hrSync, 'canImpersonate', 'federated', 'medium');

    /* risk rollup mirrors the builder: node.r = max of its permissions/roles */
    function setRisk(id, r) {
        for (var i = 0; i < nodes.length; i++) { if (nodes[i].id === id) { nodes[i].r = r; return; } }
    }

    /* ---------------- edges: permissions ---------------- */
    addEdge(hrSync, P.dirRWAll, 'permApp', null, 'critical');
    addEdge(hrSync, P.groupRWAll, 'permApp', null, 'medium');
    addEdge(hrSync, ROLE_APPADMIN, 'aadRole');
    setRisk(hrSync, 'critical');

    addEdge(finPipe, P.filesRWAll, 'permApp', null, 'medium');
    addEdge(finPipe, P.dirReadAll, 'permApp', null, 'medium');
    setRisk(finPipe, 'medium');

    addEdge(devops, P.appRWAll, 'permApp', null, 'critical');
    addEdge(devops, P.roleMgmt, 'permApp', null, 'critical');
    addEdge(devops, ROLE_GA, 'aadRole', null, 'critical');
    setRisk(devops, 'critical');

    addEdge(crm, P.mailRW, 'permApp', null, 'critical');
    addEdge(crm, P.mailSend, 'permApp', null, 'critical');
    addEdge(crm, P.exchFull, 'permApp', null, 'critical');
    setRisk(crm, 'critical');

    addEdge(marketing, P.userReadAllDel, 'permDel', 'Admin', 'medium');
    addEdge(marketing, RES.graph, 'usesApi');
    setRisk(marketing, 'medium');

    addEdge(backup, P.sitesFull, 'permApp', null, 'critical');
    addEdge(backup, P.filesRWAll, 'permApp', null, 'medium');
    setRisk(backup, 'critical');

    addEdge(intranet, P.sitesRWDel, 'permDel', 'Admin', 'medium');
    addEdge(intranet, RES.graph, 'usesApi');
    setRisk(intranet, 'medium');

    addEdge(reporting, P.dirReadAll, 'permApp', null, 'medium');
    setRisk(reporting, 'medium');

    addEdge(partner, P.userReadAllDel, 'permDel', 'Admin', 'medium');
    addEdge(partner, RES.graph, 'usesApi');
    setRisk(partner, 'medium');

    addEdge(adobe, P.mailSendDel, 'permDel', 'Admin', 'critical');
    addEdge(adobe, RES.graph, 'usesApi');
    setRisk(adobe, 'critical');

    addEdge(salesforce, P.dirReadAll, 'permApp', null, 'medium');
    addEdge(salesforce, RES.exchange, 'usesApi');
    setRisk(salesforce, 'medium');

    addEdge(zoom, RES.graph, 'usesApi');

    addEdge(miAks, RES.keyvault, 'usesApi');
    addEdge(miFunc, P.dirReadAll, 'permApp', null, 'medium');
    setRisk(miFunc, 'medium');
    addEdge(miFunc, RES.arm, 'usesApi');
    addEdge(miLogic, P.mailSend, 'permApp', null, 'critical');
    setRisk(miLogic, 'critical');

    /* agent identities: blueprint instancing, sponsors, permissions */
    addEdge(agentHr, agentBp, 'instanceOf');
    addEdge(agentSales, agentBp, 'instanceOf');
    addEdge(agentHr, P.filesRWAll, 'permApp', null, 'medium');
    setRisk(agentHr, 'medium');
    addEdge(agentSales, P.mailSend, 'permApp', null, 'critical');
    setRisk(agentSales, 'critical'); /* critical permission AND no sponsor */
    addEdge(users[6], agentHr, 'sponsors');

    /* permission -> resource API */
    Object.keys(P).forEach(function (k) {
        var pid = P[k];
        var resGuid = pid.split('|')[1];
        addEdge(pid, 'sp|' + resGuid, 'onApi');
    });

    /* ---------------- edges: ownership ---------------- */
    addEdge(users[0], hrSync, 'owns');
    addEdge(users[0], intranet, 'owns');
    addEdge(users[1], finPipe, 'owns');
    addEdge(users[2], devops, 'owns');
    addEdge(users[2], backup, 'owns');
    addEdge(users[3], marketing, 'owns');
    addEdge(users[20], crm, 'owns'); /* guest-owned app - spicy finding */
    addEdge(users[5], reporting, 'owns');
    addEdge(users[6], appOnly, 'owns');

    /* ---------------- edges: assignments & memberships ---------------- */
    for (var a = 0; a < 14; a++) { addEdge(users[a % users.length], intranet, 'assignedTo', 'User'); }
    for (var b = 4; b < 12; b++) { addEdge(users[b], reporting, 'assignedTo', 'Report.Read'); }
    addEdge(GRP_HR, hrSync, 'assignedTo', 'HRData.Sync');
    addEdge(GRP_FIN, finPipe, 'assignedTo', 'Finance.Process');
    addEdge(GRP_IT, devops, 'assignedTo', 'Deploy.Full');
    addEdge(users[21], partner, 'assignedTo', 'Portal.Access');
    addEdge(users[22], partner, 'assignedTo', 'Portal.Access');
    addEdge(devops, GRP_IT, 'memberOf');

    /* ---------------- stats ---------------- */
    var typeCounts = {}, critical = 0, medium = 0, stale = 0;
    nodes.forEach(function (n) {
        typeCounts[n.t] = (typeCounts[n.t] || 0) + 1;
        if (n.r === 'critical') { critical++; }
        else if (n.r === 'medium') { medium++; }
        if (n.m && n.m.stale) { stale++; }
    });

    window.AZADSPI_SAMPLE_DATA = {
        nodes: nodes,
        edges: edges,
        stats: {
            nodeCount: nodes.length,
            edgeCount: edges.length,
            typeCounts: typeCounts,
            criticalNodeCount: critical,
            mediumNodeCount: medium,
            staleNodeCount: stale,
            addedNodeCount: 1,
            changedNodeCount: 1,
            removedNodeCount: 1,
            includesUnclassifiedPermissionNodes: false
        }
    };
})();
