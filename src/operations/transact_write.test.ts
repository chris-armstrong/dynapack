import {
  CreateTableCommand,
  CreateTableInput,
  DeleteTableCommand,
  DynamoDBClient,
  ListTablesCommand,
} from '@aws-sdk/client-dynamodb';
import { CollectionLayout } from '../base/layout';
import { createContext } from '../context';
import { replace } from './replace';
import {
  TransactFindByIdDescriptor,
  transactFindByIds,
} from './transact_find_by_ids';
import { TransactionWriteRequest, transactionWrite } from './transact_write';
import debug from 'debug';
import { DebugTestsNamespace, debugDynamoTests } from '../debug';
import {
  IdempotentParameterMismatchException,
  TransactionValidationException,
} from '../base/exceptions';
import objectHash from 'object-hash';

const TableDefinitions = [
  {
    TableName: 'User',
    KeySchema: [
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ],
    AttributeDefinitions: [
      { AttributeName: 'pk', AttributeType: 'S' },
      { AttributeName: 'sk', AttributeType: 'S' },
    ],
    ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 },
  },
];

const layout: CollectionLayout = {
  tableName: 'User',
  primaryKey: { partitionKey: 'pk', sortKey: 'sk' },
};
const collection = {
  name: 'users',
  layout,
};

const showTimeTaken = (startTime: number) =>
  `[${new Date().getTime() - startTime}ms]`;

const LocalDDBTestKit = {
  connect: (): DynamoDBClient | null => {
    const startBy = new Date().getTime();
    try {
      const localDDBClient = new DynamoDBClient({
        endpoint: 'http://localhost:8000',
        region: 'local',
      });
      debugDynamoTests(`${showTimeTaken(startBy)} Connected to Local DDB`, '');
      return localDDBClient;
    } catch (error) {
      debugDynamoTests('Error connecting to local DDB', error);
      return null;
    }
  },
  createTables: async (
    client: DynamoDBClient,
    tableDefinitions: CreateTableInput[] = []
  ) => {
    const startBy = new Date().getTime();
    try {
      await Promise.all(
        tableDefinitions?.map((tableDefinition) => {
          const createTableCmd = new CreateTableCommand(tableDefinition);
          return client.send(createTableCmd);
        })
      );

      debugDynamoTests(
        `${showTimeTaken(startBy)} tables created in local DDB`,
        ''
      );
    } catch (error) {
      debugDynamoTests('Error creating tables in local DDB', error);
    }
  },
  deleteTables: async (client: DynamoDBClient, tableNames: string[] = []) => {
    const startBy = new Date().getTime();
    try {
      await Promise.all(
        tableNames?.map((tableName) => {
          return client.send(
            new DeleteTableCommand({
              TableName: tableName,
            })
          );
        })
      );

      debugDynamoTests(
        `${showTimeTaken(startBy)} tables deleted in local DDB`,
        ''
      );
    } catch (error) {
      debugDynamoTests('Error deleting tables in local DDB', error);
    }
  },
  listTables: async (client: DynamoDBClient) => {
    try {
      await client.send(new ListTablesCommand({}));
    } catch (error) {
      debugDynamoTests('Error listing tables in local DDB', error);
    }
  },
};

describe('transactions', () => {
  let localDDBClient: DynamoDBClient;
  const hasLocalDBEndpoint = !!process.env.LOCAL_DYNAMODB_ENDPOINT;

  // create a client with DDB local
  beforeAll(async () => {
    debug.enable(DebugTestsNamespace);
    if (hasLocalDBEndpoint) {
      localDDBClient = LocalDDBTestKit.connect() as unknown as DynamoDBClient;
    }
  });

  // create tables
  beforeAll(async () => {
    if (hasLocalDBEndpoint) {
      await LocalDDBTestKit.createTables(localDDBClient, TableDefinitions);
    }
  });

  // Delete tables
  afterAll(async () => {
    if (hasLocalDBEndpoint) {
      await LocalDDBTestKit.deleteTables(localDDBClient, [
        TableDefinitions[0].TableName,
      ]);
    }
    debug.disable();
  });

  const describeIfCondition = hasLocalDBEndpoint ? describe : describe.skip;

  describeIfCondition('write transactions', () => {
    test.each([
      { _id: 'test-id', name: 'Moriarty', email: 'moriarty@jim.com' },
      {
        _id: 'test-sh',
        name: 'Sherlock',
        email: 'sh@sh.com',
      },
    ])('Insert items to the collection using replace', async (value) => {
      const context = createContext(
        localDDBClient as unknown as DynamoDBClient,
        [collection]
      );

      const result = await replace(context, collection.name, value, {
        condition: { _id: { $exists: false } }, // condition to check user doesn't exists
      });
      expect(result).toHaveProperty('_id');
    });

    test('fetch items using transaction', async () => {
      const context = createContext(
        localDDBClient as unknown as DynamoDBClient,
        [collection]
      );

      const items: TransactFindByIdDescriptor[] = [
        {
          id: 'test-sh',
          collection: collection.name,
        },
        {
          id: 'test-id',
          collection: collection.name,
        },
      ];
      const result = await transactFindByIds(context, items);

      expect(result).toEqual([
        { name: 'Sherlock', email: 'sh@sh.com', _id: 'test-sh' },
        { name: 'Moriarty', email: 'moriarty@jim.com', _id: 'test-id' },
      ]);
    });

    test('write a transaction to ddb consisting multiple ops', async () => {
      const context = createContext(
        localDDBClient as unknown as DynamoDBClient,
        [collection]
      );

      const request = [
        {
          collectionName: collection.name,
          value: {
            _id: 'test-jw',
            lastName: 'Watson',
            firstName: 'John',
            email: 'jw@sh.sh',
          },
          options: { condition: { _id: { $exists: false } } }, // an insertion
        },
        {
          collectionName: collection.name,
          value: {
            _id: 'test-sh',
            lastName: 'Holmes',
            firstName: 'Sherlock',
            email: 'sh@sh.sh',
          }, // an update to existing user
        },
        {
          collectionName: collection.name,
          id: 'test-id',
        }, // a deletion
      ] as TransactionWriteRequest[];

      /*
       * passing custom token as running tests again and again with same payload results
       * in same token and hence assertion fails
       */
      const ClientRequestToken = objectHash(new Date().getTime(), {
        algorithm: 'md5',
        encoding: 'base64',
      });

      await transactionWrite(context, request, { ClientRequestToken });
    });

    test('fetch inserted, updated(replaced) or deleted items using transaction', async () => {
      const context = createContext(
        localDDBClient as unknown as DynamoDBClient,
        [collection]
      );

      const items: TransactFindByIdDescriptor[] = [
        {
          id: 'test-sh',
          collection: collection.name,
        },
        {
          id: 'test-jw',
          collection: collection.name,
        },
        {
          id: 'test-id',
          collection: collection.name,
        },
      ];

      const result = await transactFindByIds(context, items);

      expect(result).toEqual([
        {
          lastName: 'Holmes',
          firstName: 'Sherlock',
          _id: 'test-sh',
          email: 'sh@sh.sh',
        },
        {
          lastName: 'Watson',
          firstName: 'John',
          _id: 'test-jw',
          email: 'jw@sh.sh',
        },
      ]);
    });

    test('write a transaction to ddb consisting multiple ops for same item', async () => {
      const context = createContext(
        localDDBClient as unknown as DynamoDBClient,
        [collection]
      );

      const request = [
        {
          collectionName: collection.name,
          value: {
            _id: 'test-id-1',
            firstName: 'Neo',
            email: 'neo@matrix.com',
          }, // an update to existing user
        },
        {
          collectionName: collection.name,
          id: 'test-id-1',
        }, // a deletion
      ] as TransactionWriteRequest[];

      expect(transactionWrite(context, request)).rejects.toThrowError(
        TransactionValidationException
      );
    });

    test('writing same transaction twice with same `ClientRequestToken` to ddb', async () => {
      const context = createContext(
        localDDBClient as unknown as DynamoDBClient,
        [collection]
      );

      const request = [
        {
          collectionName: collection.name,
          value: {
            _id: 'test-bob',
            lastName: 'Bob',
            firstName: 'Sponge',
            email: 'sb@sb.sb',
          },
          options: { condition: { _id: { $exists: false } } }, // an insertion
        },
      ] as TransactionWriteRequest[];

      await transactionWrite(context, request);
      await transactionWrite(context, request);
    });

    test('writing different transaction with same `ClientRequestToken` to ddb', async () => {
      const context = createContext(
        localDDBClient as unknown as DynamoDBClient,
        [collection]
      );

      const ClientRequestToken = objectHash(new Date(), {
        algorithm: 'md5',
        encoding: 'base64',
      });

      const request1 = [
        {
          collectionName: collection.name,
          value: {
            _id: 'test-pat',
            lastName: 'Star',
            firstName: 'Patrick',
            email: 'ps@sb.sb',
          },
          options: { condition: { _id: { $exists: false } } }, // an insertion
        },
      ] as TransactionWriteRequest[];

      await transactionWrite(context, request1, { ClientRequestToken });

      const request2 = [
        {
          collectionName: collection.name,
          value: {
            _id: 'test-bob',
            lastName: 'Bob',
            firstName: 'Sponge',
            email: 'sb@sb.sb',
          },
          options: { condition: { _id: { $exists: false } } }, // an insertion
        },
      ] as TransactionWriteRequest[];

      expect(
        transactionWrite(context, request2, { ClientRequestToken })
      ).rejects.toThrowError(IdempotentParameterMismatchException);
    });
  });
});
