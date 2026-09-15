export const ADD_SERVER = /* GraphQL */ `
  mutation AddServerForMigration($input: AddServerInput!) {
    addServer(input: $input) {
      server {
        id
        name
        role
      }
      installCommand
    }
  }
`;

export const CHECK_HEALTH = /* GraphQL */ `
  mutation CheckMigrationServerHealth($id: String!) {
    checkServerHealth(id: $id, force: true) {
      id
      status
      statusMessage
    }
  }
`;

export const CHANGE_ADDRESS = /* GraphQL */ `
  mutation SetMigrationMachineAddress(
    $url: String!
    $sourceId: String!
    $id: String!
    $address: String!
  ) {
    setMigrationMachineAddress(
      url: $url
      sourceId: $sourceId
      serverId: $id
      address: $address
    )
  }
`;

export const REISSUE = /* GraphQL */ `
  mutation ReissueMigrationBootstrap($id: String!) {
    reissueServerBootstrap(id: $id) {
      server {
        id
        name
      }
      installCommand
    }
  }
`;
