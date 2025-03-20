const express = require('express');
const { Sequelize } = require('sequelize');
const router = express.Router();

// Configuration object for PGVector settings
const pgVectorConfig = {
    // Table names
    tableName: 'langchain_pg_embedding',
    collectionTableName: 'langchain_pg_collection',

    // Column names (adapted to your schema)
    columns: {
        idColumnName: 'id',
        vectorColumnName: 'embedding',
        contentColumnName: 'document',     // Changed from 'text' to 'document'
        metadataColumnName: 'cmetadata'    // Changed from 'metadata' to 'cmetadata'
    },

    // Schema name (null means public schema)
    schemaName: null,
    extensionSchemaName: null,

    // Distance strategy (can be 'cosine', 'innerProduct', or 'euclidean')
    distanceStrategy: 'cosine'
};

// Cache for valid collections - will be populated on first request
let validCollections = null;

/**
 * Fetches and caches valid collection names from the database
 * @param {Sequelize} sequelize - Sequelize instance
 * @returns {Promise<string[]>} Array of valid collection names
 */
async function getValidCollections(sequelize) {
    if (validCollections === null) {
        const query = `SELECT name FROM ${pgVectorConfig.collectionTableName}`;
        const [results] = await sequelize.query(query);
        validCollections = results.map(row => row.name);
    }
    return validCollections;
}

/**
 * Gets the computed table name with schema if necessary
 * @returns {string} The computed table name
 */
function getComputedTableName() {
    return pgVectorConfig.schemaName == null
        ? `${pgVectorConfig.tableName}`
        : `"${pgVectorConfig.schemaName}"."${pgVectorConfig.tableName}"`;
}

/**
 * Gets the computed collection table name with schema if necessary
 * @returns {string} The computed collection table name
 */
function getComputedCollectionTableName() {
    return pgVectorConfig.schemaName == null
        ? `${pgVectorConfig.collectionTableName}`
        : `"${pgVectorConfig.schemaName}"."${pgVectorConfig.collectionTableName}"`;
}

/**
 * Gets the appropriate operator string for the configured distance strategy
 * @returns {string} The operator string
 */
function getComputedOperatorString() {
    let operator;
    switch (pgVectorConfig.distanceStrategy) {
        case "cosine":
            operator = "<=>";
            break;
        case "innerProduct":
            operator = "<#>";
            break;
        case "euclidean":
            operator = "<->";
            break;
        default:
            throw new Error(`Unknown distance strategy: ${pgVectorConfig.distanceStrategy}`);
    }

    return pgVectorConfig.extensionSchemaName !== null
        ? `OPERATOR(${pgVectorConfig.extensionSchemaName}.${operator})`
        : operator;
}

/**
 * Retrieves a collection ID by name
 * @param {Sequelize} sequelize - Sequelize instance
 * @param {string} collectionName - Name of the collection
 * @returns {Promise<string|null>} The collection UUID or null if not found
 */
async function getCollectionId(sequelize, collectionName) {
    const queryString = `
    SELECT uuid FROM ${getComputedCollectionTableName()}
    WHERE name = :collectionName;
  `;

    const [results] = await sequelize.query(queryString, {
        replacements: { collectionName },
        type: Sequelize.QueryTypes.SELECT
    });

    return results ? results.uuid : null;
}

/**
 * POST /api/v3/vector/query - Vector similarity search endpoint
 * Body parameters:
 *  - query: number[] - The vector to search with
 *  - k: number - Number of results to return (default: 4)
 *  - filter: object - Optional metadata filter
 *  - includeEmbedding: boolean - Whether to include embedding vectors in results (default: false)
 *  - collectionName: string - Name of the collection to search in
 */
router.post('/query', async (req, res) => {
    try {
        // Extract parameters from request body
        const {
            query,
            k = 4,
            filter = {},
            includeEmbedding = false,
            collectionName = 'langchain'
        } = req.body;

        // Get sequelize instance from app
        const sequelize = req.app.get('sequelize');
        if (!sequelize) {
            throw new Error('Sequelize instance not found');
        }

        // ===== Input validation (commented out for future implementation) =====
        /*
        // Validate query is an array of numbers
        if (!Array.isArray(query) || query.length === 0) {
          return res.status(400).json({
            error: 'Invalid query parameter. Must be a non-empty array of numbers.'
          });
        }

        // Validate k is a positive integer
        if (!Number.isInteger(k) || k <= 0) {
          return res.status(400).json({
            error: 'Invalid k parameter. Must be a positive integer.'
          });
        }

        // Validate filter is an object
        if (filter && typeof filter !== 'object') {
          return res.status(400).json({
            error: 'Invalid filter parameter. Must be an object.'
          });
        }

        // Validate includeEmbedding is a boolean
        if (typeof includeEmbedding !== 'boolean') {
          return res.status(400).json({
            error: 'Invalid includeEmbedding parameter. Must be a boolean.'
          });
        }

        // Validate collectionName is a string
        if (typeof collectionName !== 'string') {
          return res.status(400).json({
            error: 'Invalid collectionName parameter. Must be a string.'
          });
        }
        */
        // ===== End of input validation =====

        // Check if collection name is valid
        const collections = await getValidCollections(sequelize);
        if (!collections.includes(collectionName)) {
            return res.status(404).json({
                error: `Collection "${collectionName}" not found. Valid collections are: ${collections.join(', ')}`
            });
        }

        // Get collection ID
        const collectionId = await getCollectionId(sequelize, collectionName);
        if (!collectionId) {
            return res.status(404).json({
                error: `Collection "${collectionName}" exists but ID could not be retrieved.`
            });
        }

        // Prepare the query parameters
        const embeddingString = `[${query.join(",")}]`;
        const parameters = [embeddingString, k];
        const whereClauses = [];

        // Add collection ID to where clause
        whereClauses.push("collection_id = :collectionId");
        parameters.push(collectionId);

        // Build filter clauses if filter is provided
        if (Object.keys(filter).length > 0) {
            const queryParams = {
                embeddingString,
                k,
                collectionId
            };

            // Process filter conditions
            for (const [key, value] of Object.entries(filter)) {
                if (typeof value === "object" && value !== null) {
                    if (Array.isArray(value.in)) {
                        const inPlaceholders = value.in.map((_, idx) => `:${key}_in_${idx}`).join(",");
                        whereClauses.push(`${pgVectorConfig.columns.metadataColumnName}->>'${key}' IN (${inPlaceholders})`);

                        // Add each value as a parameter
                        value.in.forEach((val, idx) => {
                            queryParams[`${key}_in_${idx}`] = val;
                        });
                    }

                    if (Array.isArray(value.arrayContains)) {
                        const arrayPlaceholders = value.arrayContains.map((_, idx) => `:${key}_contains_${idx}`).join(",");
                        whereClauses.push(`${pgVectorConfig.columns.metadataColumnName}->'${key}' ?| array[${arrayPlaceholders}]`);

                        // Add each value as a parameter
                        value.arrayContains.forEach((val, idx) => {
                            queryParams[`${key}_contains_${idx}`] = val;
                        });
                    }
                } else {
                    // Simple equality
                    whereClauses.push(`${pgVectorConfig.columns.metadataColumnName}->>'${key}' = :${key}`);
                    queryParams[key] = value;
                }
            }

            // Construct the complete query with filter conditions
            const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

            const queryString = `
        SELECT *, "${pgVectorConfig.columns.vectorColumnName}" ${getComputedOperatorString()} :embeddingString as "_distance"
        FROM ${getComputedTableName()}
        ${whereClause}
        ORDER BY "_distance" ASC
        LIMIT :k;
      `;

            // Execute the query with the filter
            const documents = await sequelize.query(queryString, {
                replacements: queryParams,
                type: Sequelize.QueryTypes.SELECT
            });

            // Process results
            const results = [];
            for (const doc of documents) {
                if (doc._distance != null && doc[pgVectorConfig.columns.contentColumnName] != null) {
                    const document = {
                        pageContent: doc[pgVectorConfig.columns.contentColumnName],
                        metadata: doc[pgVectorConfig.columns.metadataColumnName],
                        id: doc[pgVectorConfig.columns.idColumnName]
                    };

                    if (includeEmbedding) {
                        document.metadata[pgVectorConfig.columns.vectorColumnName] = doc[pgVectorConfig.columns.vectorColumnName];
                    }

                    results.push([document, doc._distance]);
                }
            }

            return res.json(results);
        } else {
            // Simpler query without complex filters
            const whereClause = `WHERE collection_id = :collectionId`;

            const queryString = `
        SELECT *, "${pgVectorConfig.columns.vectorColumnName}" ${getComputedOperatorString()} :embeddingString as "_distance"
        FROM ${getComputedTableName()}
        ${whereClause}
        ORDER BY "_distance" ASC
        LIMIT :k;
      `;

            // Execute the query
            const documents = await sequelize.query(queryString, {
                replacements: {
                    embeddingString,
                    k,
                    collectionId
                },
                type: Sequelize.QueryTypes.SELECT
            });

            // Process results
            const results = [];
            for (const doc of documents) {
                if (doc._distance != null && doc[pgVectorConfig.columns.contentColumnName] != null) {
                    const document = {
                        pageContent: doc[pgVectorConfig.columns.contentColumnName],
                        metadata: doc[pgVectorConfig.columns.metadataColumnName],
                        id: doc[pgVectorConfig.columns.idColumnName]
                    };

                    if (includeEmbedding) {
                        document.metadata[pgVectorConfig.columns.vectorColumnName] = doc[pgVectorConfig.columns.vectorColumnName];
                    }

                    results.push([document, doc._distance]);
                }
            }

            return res.json(results);
        }
    } catch (error) {
        // Error handling - leave placeholder for custom error handling
        console.error('Error in vector search:', error);
        return res.status(500).json({
            error: 'Internal server error',
            message: error.message
        });
    }
});

module.exports = router;