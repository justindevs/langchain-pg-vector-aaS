const express = require('express');
const pgVectorRouter = require('./path/to/pg-vector-router');

const app = express();
app.use(express.json());

// Set up sequelize instance
const sequelize = new Sequelize(/* your config */);
app.set('sequelize', sequelize);

// Use the router
app.use('/api/v3/vector', pgVectorRouter);