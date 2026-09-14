export const START = /* GraphQL */ `
  mutation StartMigration(
    $input: MigrationSourceInput!
    $orgName: String
    $targets: [MigrationRunTargetInput!]!
    $servers: [MigrationServerChoiceInput!]
    $queued: [MigrationQueuedTeamInput!]
  ) {
    startMigration(
      input: $input
      orgName: $orgName
      targets: $targets
      servers: $servers
      queued: $queued
    )
  }
`;

export const IDENTIFY = /* GraphQL */ `
  mutation IdentifyMigrationSource($input: MigrationSourceInput!) {
    identifyMigrationSource(input: $input) {
      platform
      teamId
      teamName
      otherTeams
    }
  }
`;

export const SCAN = /* GraphQL */ `
  mutation ScanMigrationSource(
    $input: MigrationSourceInput!
    $newTeam: Boolean
  ) {
    scanMigrationSource(input: $input, newTeam: $newTeam) {
      platform
      sourceUrl
      orgName
      otherTeams
      servers {
        sourceId
        name
        ipAddress
        cloudflare
        deploServerId
        deploServerName
        deploServerOnline
      }
      members {
        email
        name
        sourceRole
        hasAccount
        avatarUrl
        avatarColor
        inTeam
      }
      projects {
        sourceId
        name
        exists
        environments {
          sourceId
          name
          exists
          services {
            sourceId
            kind
            name
            targetKind
            status
            sourceServerId
            buildsFromSource
            engine
            exposedPort
            domains
            logo
            notes
          }
        }
      }
    }
  }
`;

export const STOP = /* GraphQL */ `
  mutation StopMigration($runId: String!) {
    stopMigration(runId: $runId)
  }
`;

export const CREATE_TEAM = /* GraphQL */ `
  mutation CreateMigrationTeam($name: String!, $image: String) {
    createTeam(name: $name, image: $image) {
      id
    }
  }
`;

export const FLEET = /* GraphQL */ `
  query MigrationFleet {
    servers {
      id
      name
      role
      isDeploHost
    }
    buildServerChoices {
      id
      name
      buildOnly
      isDeploHost
    }
  }
`;

export const HAND_OVER_SOURCES = /* GraphQL */ `
  mutation HandOverMigrationSources($fromTeamId: String!) {
    handOverMigrationSources(fromTeamId: $fromTeamId)
  }
`;

export const DISMISS = /* GraphQL */ `
  mutation DismissMigrationReport($runId: String!) {
    dismissMigrationReport(runId: $runId)
  }
`;

export const ABANDON = /* GraphQL */ `
  mutation AbandonMigration {
    abandonMigration
  }
`;

export const SESSION = /* GraphQL */ `
  query MigrationSession($runId: String!) {
    migrationSession(runId: $runId) {
      id
      teamId
      teamName
      teamAvatarUrl
      orgName
      status
      created
      skipped
      failed
      manual
      error
      members {
        email
        name
        link
        outcome
        message
        sourceRole
        hasAccount
        avatarUrl
      }
    }
  }
`;

export const MINT_LINK = /* GraphQL */ `
  mutation MintImportInviteLink($input: MintRegistrationLinkInput!) {
    mintRegistrationLink(input: $input)
  }
`;
