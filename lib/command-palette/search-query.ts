export const SEARCH_QUERY = /* GraphQL */ `
  query PaletteSearch($q: String!) {
    search(q: $q) {
      apps {
        id
        name
        slug
        logo
        team {
          id
          name
          slug
          avatarUrl
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
          slug
          avatarUrl
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
          slug
          avatarUrl
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
          slug
          avatarUrl
        }
      }
      folders {
        id
        name
        team {
          id
          name
          slug
          avatarUrl
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
          slug
          avatarUrl
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
          slug
          avatarUrl
        }
      }
      roles {
        id
        name
        memberCount
        team {
          id
          name
          slug
          avatarUrl
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
          slug
          avatarUrl
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
