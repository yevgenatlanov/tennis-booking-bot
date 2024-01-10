import * as admin from 'firebase-admin';

const serviceAccount = require('../kas-tenniscourt-booking-firebase-adminsdk-nesoo-e565613f3c.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

export { db };
