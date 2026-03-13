const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');

const AWS_REGION = process.env.AWS_REGION;
const SES_FROM_EMAIL = process.env.SES_FROM_EMAIL;
const ADMIN_NOTIFICATION_EMAILS = (process.env.ADMIN_NOTIFICATION_EMAILS || '')
  .split(',')
  .map(e => e.trim())
  .filter(Boolean);

let sesClient = null;

if (AWS_REGION) {
  sesClient = new SESClient({ region: AWS_REGION });
} else {
  console.warn('AWS_REGION is not set; SES client will not be initialized.');
}

/**
 * Send notification email to administrators when a new RegistrationRequest is created.
 *
 * @param {Object} requestData
 * @param {string} requestData.id
 * @param {string} requestData.email
 * @param {string} requestData.name
 * @param {string} requestData.reason
 * @param {string} requestData.createdAt
 */
async function sendAdminNotificationEmail(requestData) {
  if (!sesClient || !SES_FROM_EMAIL || ADMIN_NOTIFICATION_EMAILS.length === 0) {
    console.warn(
      'Email configuration incomplete. Skipping SES send. ' +
        'Ensure AWS_REGION, SES_FROM_EMAIL, and ADMIN_NOTIFICATION_EMAILS are set.'
    );
    return;
  }

  const subject = 'New Registration Request Pending Approval';

  const textBody = [
    'A new registration request is pending approval.',
    '',
    `Request ID: ${requestData.id}`,
    `Email: ${requestData.email}`,
    `Name: ${requestData.name || ''}`,
    '',
    'Reason:',
    requestData.reason || '',
    '',
    `Created At: ${requestData.createdAt}`,
    ''
  ].join('\n');

  const htmlBody = `
    <html>
      <body>
        <p>A new registration request is pending approval.</p>
        <ul>
          <li><strong>Request ID:</strong> ${requestData.id}</li>
          <li><strong>Email:</strong> ${requestData.email}</li>
          <li><strong>Name:</strong> ${requestData.name || ''}</li>
        </ul>
        <p><strong>Reason:</strong></p>
        <p>${(requestData.reason || '').replace(/\n/g, '<br />')}</p>
        <p><strong>Created At:</strong> ${requestData.createdAt}</p>
      </body>
    </html>
  `;

  const command = new SendEmailCommand({
    Source: SES_FROM_EMAIL,
    Destination: {
      ToAddresses: ADMIN_NOTIFICATION_EMAILS
    },
    Message: {
      Subject: {
        Data: subject,
        Charset: 'UTF-8'
      },
      Body: {
        Text: {
          Data: textBody,
          Charset: 'UTF-8'
        },
        Html: {
          Data: htmlBody,
          Charset: 'UTF-8'
        }
      }
    }
  });

  await sesClient.send(command);
}

module.exports = {
  sendAdminNotificationEmail
};

