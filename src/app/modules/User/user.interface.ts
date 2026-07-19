import mongoose, { Model } from "mongoose";
import { TUserRole } from "../Auth/auth.constant";

export interface TUser {
  _id?: mongoose.Types.ObjectId;
  firstName: string;
  lastName: string;
  fullName?: string;
  image?: string;
  email: string;
  password?: string;
  institution?: string;
  verification?: {
    code: string | null;
    expireDate: Date | null;
  };
  status: 'active' | 'blocked';
  role: TUserRole;
  isOtpVerified: boolean;
  passwordChangedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IUserMethods {
  compareVerificationCode(userPlaneCode: string): boolean;
}

export interface User extends Model<TUser, {}, IUserMethods> {
  isUserExistsByEmail(email: string): Promise<TUser>;
  isUserExistsById(id: string): Promise<TUser>;
  isPasswordMatched(plainTextPassword: string, hashedPassword: string): Promise<boolean>;
  isJWTIssuedBeforePasswordChanged(passwordChangedTimestamp: Date, jwtIssuedTimestamp: number): boolean;
}