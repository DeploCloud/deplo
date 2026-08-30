// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

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
          avatarUrl
        }
      }
      folders {
        id
        name
        team {
          id
          name
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
