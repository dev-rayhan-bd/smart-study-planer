import * as admin from 'firebase-admin';
import { NotificationModel } from '../modules/Notification/notification.model';
import { UserModel } from '../modules/User/user.model';
import * as fs from 'fs';
import * as path from 'path';

// Firebase Initialize — gracefully handle missing config file
let firebaseInitialized = false;

try {
  const configPath = path.resolve(__dirname, '../../../firebase-admin-config.json');
  if (fs.existsSync(configPath)) {
    const serviceAccount = require(configPath);
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
      firebaseInitialized = true;
      console.log('Firebase initialized successfully.');
    }
  } else {
    console.warn('firebase-admin-config.json not found. Push notifications disabled.');
  }
} catch (error) {
  console.warn('Firebase initialization skipped:', (error as Error).message);
  console.warn('Push notifications will be disabled.');
}

export const sendNotification = async (
  userId: string,
  title: string,
  message: string,
  type: string = 'general'
) => {
  try {

    await NotificationModel.create({
      user: userId,
      title,
      message,
      // type
    });

 
    const user = await UserModel.findById(userId);
    
    if (user && user.fcmToken && firebaseInitialized) {
      const payload = {
        notification: {
          title,
          body: message,
        },
        apns: {
          payload: {
            aps: {
              sound: "default",
              badge: 1,
            },
          },
        },
        android: {
          notification: {
            sound: "default",
          },
        },
        token: user.fcmToken,
      };

      await admin.messaging().send(payload);
      console.log('Successfully sent push notification');
    }
  } catch (error) {
    console.error('Error sending notification:', error);
  }
};

export const sendNotificationToAdmins = async (
  title: string,
  message: string,
  type: string = 'general'
) => {
  try {

    const admins = await UserModel.find({ 
      role: { $in: ['admin', 'superAdmin'] } 
    });

    for (const admin of admins) {

      await sendNotification(admin._id.toString(), title, message, type);
    }
  } catch (error) {
    console.error('Error sending notification to admins:', error);
  }
};