# Authentik - Password Reset / Recovery Portal

Setting up a self-service password reset portal

Written instructions can be found here, however a great Youtube video that details this process can also be found below.

[![Authentik Password Recovery Flow](https://img.youtube.com/vi/NKJkYz0BIlA/hqdefault.jpg)](https://www.youtube.com/watch?v=NKJkYz0BIlA)

---

## Requirements

You must already have

- Access to the **Authentik Admin UI**
- Access to an SMTP Email Server (Instructions can be found online to obtain this info for Gmail and other providers)

---

## Pass your SMTP Details to Authentik Via .env
1. Follow the steps located [here](https://docs.goauthentik.io/install-config/email/) to setup and test Authentik with your SMTP Email Server

## 1. Define a Password Policy
1. Open the Authentik Admin Interface and navigate to **Customisation → Policies**
2. Click **Create**
3. Select **Password Policy**
4. Set the **Name** to `password-complexity`
5. Set the **Static Rules** to the standard that you would like your passwords to be. and click **Finish**
    *Note: Align this with TAK Portal Settings → Authentication → Password Policy (defaults: 12+ characters with uppercase, lowercase, number, and symbol).*


## 2. Create a Recovery Email and Identification Stage

1. Navigate to **Flows & Stages → Stages**
2. Click **Create**
3. Select **Identification Stage**
4. Name it `Recovery Identification`
5. Click **Create**
6. Select **Email Stage**
7. Name it `Recovery Email` and change the subject to `Password Recovery`

## 3. Create a Recovery Flow

1. Navigate to **Flows & Stages → Flows**
2. Click **Create**
3. Set the name, title, and slug to `Password Recovery`
4. Set the designation to `Recovery` and click **Create**

## 4. Edit the Recovery Flow

1. Select the flow we just created `Password Recovery`
2. Navigate to **Stage Bindings**
3. Select **Bind Existing Stage**
4. Select the `Recovery Identification` stage from earlier, set the order to `0`, anc click **Create**
5. Select the `Recovery Email` stage from earlier, set the order to `10`, and click **Create**
6. Select the `default-password-change-prompt`, set the order to `20`, and click **Create**
7. Select the `default-password-change-write`, set the order to `30`, and click **Create**
8. Click **Edit Stage** on the `default-password-change-prompt`
9. Locate `Validation Policies` and remove the default validation policy by selecting it and clicking the left arrow
10. Search `Available Policies` and add the `password-complexity` policy from earlier to the right `Selected Policies`

## 5. Link the Recovery Flow

1. Navigate to **Flows & Stages → Flows**
2. Locate your `default-authentication-flow` and click on it
3. Navigate to **Stage Bindings**
4. Locate `default-authentication-identification` and click **Edit Stage**
5. Select the `Password Stage` field and select `default-authentication-password`, then expand the `Flow Settings` and set ` Password Recovery` for the `Recovery Flow` and click **Save**
6. Select the checkbox for `default-authentication-password` and click **Delete**

## Now you should be ready to test this functionality by logging out of the Authentik Portal.