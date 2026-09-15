export const Q = {
  apps: /* GraphQL */ `
    {
      apps {
        id
      }
    }
  `,
  app: /* GraphQL */ `
    query ($slug: String!) {
      app(slug: $slug) {
        id
      }
    }
  `,
  members: /* GraphQL */ `
    {
      members {
        userId
      }
    }
  `,
  roles: /* GraphQL */ `
    {
      teamRoles {
        id
      }
    }
  `,
  databases: /* GraphQL */ `
    {
      databases {
        id
      }
    }
  `,
  servers: /* GraphQL */ `
    {
      servers {
        id
      }
    }
  `,
  sharedVars: /* GraphQL */ `
    {
      sharedVars {
        id
      }
    }
  `,
  env: /* GraphQL */ `
    query ($appId: String!) {
      env(appId: $appId) {
        id
      }
    }
  `,
  activity: /* GraphQL */ `
    {
      activity {
        id
        appId
        message
      }
    }
  `,
  folders: /* GraphQL */ `
    {
      folders {
        id
      }
    }
  `,
  projects: /* GraphQL */ `
    {
      projects {
        id
      }
    }
  `,
  folderGrants: /* GraphQL */ `
    query ($folderId: ID!) {
      folderGrants(folderId: $folderId) {
        userId
        capabilities
      }
    }
  `,
  search: /* GraphQL */ `
    query ($q: String!) {
      search(q: $q, kinds: [app]) {
        apps {
          id
        }
      }
    }
  `,
};
