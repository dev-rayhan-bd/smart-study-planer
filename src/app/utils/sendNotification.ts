import { NotificationModel } from '../modules/Notification/notification.model';
import { UserModel } from '../modules/User/user.model';

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