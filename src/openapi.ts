export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Solswap Indexer API',
    version: '0.2.0',
    description: 'Read-only Solana wallet and Solswap analytics indexer API.',
  },
  components: {
    schemas: {
      ServiceInfoResponse: {
        type: 'object',
        required: [
          'schemaVersion',
          'serviceId',
          'serviceName',
          'ecosystem',
          'chainId',
          'network',
          'publicBaseUrl',
          'readOnly',
          'capabilities',
          'endpoints',
        ],
        properties: {
          schemaVersion: { type: 'integer', enum: [1] },
          serviceId: { type: 'string', enum: ['si.soramitsu.io'] },
          serviceName: { type: 'string' },
          ecosystem: { type: 'string', enum: ['solana'] },
          chainId: { type: 'string', enum: ['solana:mainnet'] },
          network: { type: 'string', enum: ['mainnet'] },
          publicBaseUrl: { type: 'string', format: 'uri' },
          readOnly: { type: 'boolean', enum: [true] },
          capabilities: { type: 'array', items: { type: 'string' } },
          endpoints: { type: 'object', additionalProperties: { type: 'string' } },
        },
      },
      TokenTransferFee: {
        type: 'object',
        required: ['epoch', 'maximumFee', 'transferFeeBasisPoints'],
        properties: {
          epoch: { type: 'string', nullable: true },
          maximumFee: { type: 'string', nullable: true },
          transferFeeBasisPoints: { type: 'integer', nullable: true, minimum: 0 },
        },
      },
      TokenTransferFeeConfig: {
        type: 'object',
        required: [
          'transferFeeConfigAuthority',
          'withdrawWithheldAuthority',
          'withheldAmount',
          'olderTransferFee',
          'newerTransferFee',
        ],
        properties: {
          transferFeeConfigAuthority: { type: 'string', nullable: true },
          withdrawWithheldAuthority: { type: 'string', nullable: true },
          withheldAmount: { type: 'string', nullable: true },
          olderTransferFee: { allOf: [{ $ref: '#/components/schemas/TokenTransferFee' }], nullable: true },
          newerTransferFee: { allOf: [{ $ref: '#/components/schemas/TokenTransferFee' }], nullable: true },
        },
      },
      TokenTransferHook: {
        type: 'object',
        required: ['authority', 'programId', 'extraAccountMetasAddress'],
        properties: {
          authority: { type: 'string', nullable: true },
          programId: { type: 'string', nullable: true },
          extraAccountMetasAddress: { type: 'string', nullable: true },
        },
      },
      TokenMetadataResponse: {
        type: 'object',
        required: [
          'mint',
          'exists',
          'program',
          'programId',
          'extensions',
          'transferFeeConfig',
          'transferHook',
          'decimals',
          'supply',
          'uiSupplyString',
          'mintAuthority',
          'freezeAuthority',
          'isInitialized',
          'name',
          'symbol',
          'uri',
          'syncedAt',
        ],
        properties: {
          mint: { type: 'string' },
          exists: { type: 'boolean' },
          program: { type: 'string', enum: ['spl-token', 'token-2022', 'unknown'] },
          programId: { type: 'string', nullable: true },
          extensions: { type: 'array', items: { type: 'string' } },
          transferFeeConfig: { allOf: [{ $ref: '#/components/schemas/TokenTransferFeeConfig' }], nullable: true },
          transferHook: { allOf: [{ $ref: '#/components/schemas/TokenTransferHook' }], nullable: true },
          decimals: { type: 'integer', nullable: true, minimum: 0 },
          supply: { type: 'string', nullable: true },
          uiSupplyString: { type: 'string', nullable: true },
          mintAuthority: { type: 'string', nullable: true },
          freezeAuthority: { type: 'string', nullable: true },
          isInitialized: { type: 'boolean', nullable: true },
          name: { type: 'string', nullable: true },
          symbol: { type: 'string', nullable: true },
          uri: { type: 'string', nullable: true },
          syncedAt: { type: 'integer' },
        },
      },
    },
  },
  paths: {
    '/api/indexer/v1/health': {
      get: {
        summary: 'Health check',
        responses: { '200': { description: 'Service health' } },
      },
    },
    '/api/indexer/v1/service-info': {
      get: {
        summary: 'Wallet-facing service metadata',
        responses: {
          '200': {
            description: 'Service metadata response',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ServiceInfoResponse' },
              },
            },
          },
        },
      },
    },
    '/api/indexer/v1/accounts/{wallet}/balances': {
      get: {
        summary: 'Wallet SOL and SPL token balances',
        parameters: [{ name: 'wallet', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Wallet balances' },
          '400': { description: 'Invalid wallet address' },
        },
      },
    },
    '/api/indexer/v1/accounts/{wallet}/assets': {
      get: {
        summary: 'Wallet native and token assets',
        parameters: [{ name: 'wallet', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Wallet assets' },
          '400': { description: 'Invalid wallet address' },
        },
      },
    },
    '/api/indexer/v1/accounts/{wallet}/state': {
      get: {
        summary: 'Wallet account state',
        parameters: [{ name: 'wallet', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Wallet account state' },
          '400': { description: 'Invalid wallet address' },
        },
      },
    },
    '/api/indexer/v1/accounts/{wallet}/txs': {
      get: {
        summary: 'Paged wallet transaction history',
        parameters: [
          { name: 'wallet', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'before', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 250 } },
        ],
        responses: {
          '200': { description: 'Wallet transactions' },
          '400': { description: 'Invalid wallet address or query' },
        },
      },
    },
    '/api/indexer/v1/tokens/{mint}/metadata': {
      get: {
        summary: 'Mint metadata and supply',
        parameters: [{ name: 'mint', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'Token metadata',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/TokenMetadataResponse' },
              },
            },
          },
          '400': { description: 'Invalid mint address' },
        },
      },
    },
    '/api/indexer/v1/tokens/metadata': {
      post: {
        summary: 'Batch mint metadata and supply',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['mints'],
                properties: {
                  mints: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string' } },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Token metadata batch',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['total', 'syncedAt', 'tokens'],
                  properties: {
                    total: { type: 'integer' },
                    syncedAt: { type: 'integer' },
                    tokens: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/TokenMetadataResponse' },
                    },
                  },
                },
              },
            },
          },
          '400': { description: 'Invalid mint list' },
        },
      },
    },
    '/api/indexer/v1/accounts/{wallet}/swaps': {
      get: {
        summary: 'Wallet Solswap route history',
        parameters: [{ name: 'wallet', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Wallet swaps' } },
      },
    },
    '/api/indexer/v1/accounts/{wallet}/spot-positions': {
      get: {
        summary: 'Wallet spot position summary',
        parameters: [{ name: 'wallet', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Spot positions' } },
      },
    },
    '/api/indexer/v1/accounts/{wallet}/pending-intents': {
      get: {
        summary: 'Pending batch intents',
        parameters: [
          { name: 'wallet', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'marketAddress', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'Pending intents' } },
      },
    },
    '/api/indexer/v1/markets/{marketAddress}/candles': {
      get: {
        summary: 'Market candles',
        parameters: [
          { name: 'marketAddress', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'interval', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } },
        ],
        responses: { '200': { description: 'Market candles' } },
      },
    },
    '/api/indexer/v1/markets/{marketAddress}/overview': {
      get: {
        summary: 'Market overview',
        parameters: [{ name: 'marketAddress', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Market overview' } },
      },
    },
  },
}
