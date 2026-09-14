// M holds every write document the persona suites send.
export const M = {
  redeploy: /* GraphQL */ `
    mutation ($appId: String!) {
      redeploy(appId: $appId) {
        id
      }
    }
  `,
  stopApp: /* GraphQL */ `
    mutation ($id: String!) {
      stopApp(id: $id) {
        id
      }
    }
  `,
  renameApp: /* GraphQL */ `
    mutation ($id: String!, $name: String!) {
      renameApp(id: $id, name: $name) {
        id
      }
    }
  `,
  deleteApp: /* GraphQL */ `
    mutation ($id: String!) {
      deleteApp(id: $id)
    }
  `,
  deleteApps: /* GraphQL */ `
    mutation ($ids: [ID!]!) {
      deleteApps(ids: $ids)
    }
  `,
  upsertEnv: /* GraphQL */ `
    mutation ($input: UpsertEnvInput!) {
      upsertEnv(input: $input) {
        id
      }
    }
  `,
  addDomain: /* GraphQL */ `
    mutation ($appId: String!, $name: String!) {
      addDomain(appId: $appId, name: $name) {
        id
      }
    }
  `,
  createApp: /* GraphQL */ `
    mutation ($input: CreateAppInput!) {
      createApp(input: $input) {
        id
      }
    }
  `,
  createFolder: /* GraphQL */ `
    mutation ($name: String!) {
      createFolder(name: $name) {
        id
      }
    }
  `,
  deleteFolder: /* GraphQL */ `
    mutation ($id: ID!, $deleteApps: Boolean) {
      deleteFolder(id: $id, deleteApps: $deleteApps)
    }
  `,
  createProject: /* GraphQL */ `
    mutation ($name: String!) {
      createProject(name: $name) {
        id
      }
    }
  `,
  deleteProject: /* GraphQL */ `
    mutation ($id: ID!) {
      deleteProject(id: $id, deleteApps: false)
    }
  `,
  createDatabase: /* GraphQL */ `
    mutation ($input: CreateDatabaseInput!) {
      createDatabase(input: $input) {
        id
      }
    }
  `,
  deleteDatabase: /* GraphQL */ `
    mutation ($id: String!) {
      deleteDatabase(id: $id)
    }
  `,
  revealConnection: /* GraphQL */ `
    mutation ($id: String!) {
      revealConnection(id: $id)
    }
  `,
  addMember: /* GraphQL */ `
    mutation ($input: AddMemberInput!) {
      addExistingMember(input: $input) {
        userId
        roleId
      }
    }
  `,
  removeMember: /* GraphQL */ `
    mutation ($userId: String!) {
      removeMember(userId: $userId)
    }
  `,
  updateMember: /* GraphQL */ `
    mutation ($input: UpdateMemberInput!) {
      updateMember(input: $input) {
        userId
      }
    }
  `,
  setMemberAccess: /* GraphQL */ `
    mutation ($input: SetMemberAccessInput!) {
      setMemberAccess(input: $input) {
        teamId
        customCapabilities
        granular
      }
    }
  `,
  addUserToTeam: /* GraphQL */ `
    mutation ($input: UserTeamInput!) {
      addUserToTeam(input: $input) {
        teamId
      }
    }
  `,
  removeUserFromTeam: /* GraphQL */ `
    mutation ($input: UserTeamInput!) {
      removeUserFromTeam(input: $input) {
        teamId
      }
    }
  `,
  setUserTeamAccess: /* GraphQL */ `
    mutation ($input: SetUserTeamAccessInput!) {
      setUserTeamAccess(input: $input) {
        teamId
        granular
      }
    }
  `,
  createRole: /* GraphQL */ `
    mutation ($input: CreateRoleInput!) {
      createRole(input: $input) {
        id
      }
    }
  `,
  updateRole: /* GraphQL */ `
    mutation ($input: UpdateRoleInput!) {
      updateRole(input: $input)
    }
  `,
  deleteRole: /* GraphQL */ `
    mutation ($id: String!) {
      deleteRole(id: $id)
    }
  `,
  createToken: /* GraphQL */ `
    mutation ($input: CreateTokenInput!) {
      createToken(input: $input) {
        raw
        token {
          id
        }
      }
    }
  `,
  updateTeam: /* GraphQL */ `
    mutation ($input: UpdateTeamInput!) {
      updateTeam(input: $input) {
        id
      }
    }
  `,
  deleteTeam: /* GraphQL */ `
    mutation ($teamId: String!) {
      deleteTeam(teamId: $teamId)
    }
  `,
  switchTeam: /* GraphQL */ `
    mutation ($teamId: String!) {
      switchTeam(teamId: $teamId)
    }
  `,
  setFolderGrant: /* GraphQL */ `
    mutation ($folderId: ID!, $userId: ID!, $capabilities: [String!]!) {
      setFolderGrant(
        folderId: $folderId
        userId: $userId
        capabilities: $capabilities
      ) {
        userId
        capabilities
      }
    }
  `,
  moveAppToFolder: /* GraphQL */ `
    mutation ($appId: ID!, $folderId: ID) {
      moveAppToFolder(appId: $appId, folderId: $folderId)
    }
  `,
  moveAppsToFolder: /* GraphQL */ `
    mutation ($appIds: [ID!]!, $folderId: ID) {
      moveAppsToFolder(appIds: $appIds, folderId: $folderId)
    }
  `,
  rollback: /* GraphQL */ `
    mutation ($deploymentId: String!) {
      rollbackDeployment(deploymentId: $deploymentId) {
        id
      }
    }
  `,
  cancel: /* GraphQL */ `
    mutation ($id: String!) {
      cancelDeployment(id: $id)
    }
  `,
};

export const envInput = (appId: string) => ({
  input: { appId, key: "LAB_KEY", value: "1", type: "plain" },
});
export const newApp = (
  name: string,
  placement: Record<string, string> = {},
) => ({
  input: { name, source: "UPLOAD", ...placement },
});
