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

// CHECK_HEALTH is a live probe, not a read of the stored row - the point of the gate.
export const CHECK_HEALTH = /* GraphQL */ `
  mutation CheckMigrationServerHealth($id: String!) {
    checkServerHealth(id: $id, force: true) {
      id
      status
      statusMessage
    }
  }
`;

// CHANGE_ADDRESS files a proved address against the source, so the next attempt
// registers the machine where it really is instead of at the panel's name.
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

// REISSUE brings a registered machine's command back - without it the only way
// past this step is deleting the server by hand.
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
