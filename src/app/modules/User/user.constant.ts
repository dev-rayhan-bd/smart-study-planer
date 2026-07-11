export type TEditProfile = {
  image?: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  institution?: string;
  fcmToken?: string;
};
export const UserSearchableFields = ['firstName', 'lastName', 'email', 'institution'];