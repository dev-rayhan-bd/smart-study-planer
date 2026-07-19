export type TEditProfile = {
  image?: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  institution?: string;
};
export const UserSearchableFields = ['firstName', 'lastName', 'email', 'institution'];