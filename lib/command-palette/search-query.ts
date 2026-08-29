/**
 * What the palette asks the server for. Kept out of the component so a test
 * can validate it against `schema.graphql`: a renamed field would otherwise
 * only fail at runtime, on a keystroke.
 */
export const SEARCH_QUERY = /* GraphQL */ `
  query PaletteSearch($q: String!) {
    search(q: $q) {
      apps {
        id
        name
        slug
        logo
        productionUrl
        team {
          id
          name
        }
      }
      databases {
        id
        name
        logo
        type
        team {
          id
          name
        }
      }
      servers {
        id
        name
        host
      }
      projects {
        id
        name
        team {
          id
          name
        }
      }
      environments {
        id
        name
        projectId
        projectName
        team {
          id
          name
        }
      }
      folders {
        id
        name
        team {
          id
          name
        }
      }
      domains {
        id
        name
        appSlug
        appName
        team {
          id
          name
        }
      }
      members {
        userId
        name
        username
        avatarUrl
        avatarColor
        team {
          id
          name
        }
      }
      roles {
        id
        name
        memberCount
        team {
          id
          name
        }
      }
      cronJobs {
        id
        name
        targetKind
        targetRef
        targetName
        team {
          id
          name
        }
      }
      templates {
        slug
        name
        logo
      }
    }
  }
`;
