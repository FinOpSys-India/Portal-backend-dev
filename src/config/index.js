'use strict';

const dotenv = require('dotenv');

dotenv.config();


const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT, 10) || 3000,
  corsOrigin: process.env.CORS_ORIGIN || '*',
  db: {
    // When set (e.g. Supabase/Neon), the connection string takes precedence
    // over the individual DB_* fields below.
    url: process.env.DATABASE_URL || '',
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'Finopsys Portal',
    // Supabase requires SSL. Enabled automatically for a remote connection
    // string, or force it with DB_SSL=true.
    ssl: process.env.DB_SSL === 'true' || Boolean(process.env.DATABASE_URL),
  },
};

config.isProduction = config.env === 'production';
config.isDevelopment = config.env === 'development';

module.exports = config;
