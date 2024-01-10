import * as admin from 'firebase-admin';
require('dotenv').config();

const serviceAccountEnv = process.env.SA;
if (!serviceAccountEnv) {
  throw new Error('The SA environment variable is not set.');
}

const serviceAccount = JSON.parse(serviceAccountEnv);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

export { db };
