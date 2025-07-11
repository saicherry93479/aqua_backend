// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck
import { FastifyInstance } from 'fastify';
import { eq, and, or, inArray, isNull, notInArray } from 'drizzle-orm';
import { orders, payments, users, products, rentals, franchiseAreas } from '../models/schema';
import * as userService from './user.service';
import * as franchiseService from './franchise.service';
import * as notificationService from './notification.service';
import { OrderType, OrderStatus, PaymentStatus, PaymentType, User, NotificationType, NotificationChannel, UserRole, RentalStatus } from '../types';
import { generateId, parseJsonSafe } from '../utils/helpers';
import { notFound, badRequest, serverError } from '../utils/errors';
import crypto from 'crypto';
import { getFastifyInstance } from '../shared/fastify-instance';

// Get all orders
export async function getAllOrders(status?: OrderStatus, type?: OrderType, user?: User) {
  const fastify = getFastifyInstance();

  let results;

  // Apply filters based on user role and parameters
  if (user && user.role === UserRole.FRANCHISE_OWNER) {
    if (!user.franchiseAreaId) {
      return []; // No franchise area assigned
    }

    // Get all customers in this franchise area
    const customersInArea = await fastify.db.query.users.findMany({
      where: eq(users.franchiseAreaId, user.franchiseAreaId),
    });

    const customerIds = customersInArea.map(customer => customer.id);

    if (customerIds.length === 0) {
      return [];
    }

    let whereConditions = inArray(orders.customerId, customerIds);

    if (status) {
      whereConditions = and(whereConditions, eq(orders.status, status));
    }

    if (type) {
      whereConditions = and(whereConditions, eq(orders.type, type));
    }

    results = await fastify.db.query.orders.findMany({
      where: whereConditions,
      with: {
        customer: true,
        product: true,
        serviceAgent: true,
        payments: true,
      },
    });
  } else if (user && user.role === UserRole.SERVICE_AGENT) {
    // Service agents can only see orders assigned to them
    let whereConditions = eq(orders.serviceAgentId, user.userId);

    if (status) {
      whereConditions = and(whereConditions, eq(orders.status, status));
    }

    if (type) {
      whereConditions = and(whereConditions, eq(orders.type, type));
    }

    results = await fastify.db.query.orders.findMany({
      where: whereConditions,
      with: {
        customer: true,
        product: true,
        serviceAgent: true,
        payments: true,
      },
    });
  } else {
    // Admin can see all orders
    // Build the query based on filters
    let conditions = undefined;

    if (status) {
      conditions = eq(orders.status, status);
    }

    if (type) {
      conditions = conditions
        ? and(conditions, eq(orders.type, type))
        : eq(orders.type, type);
    }

    // Apply the filters
    results = await fastify.db.query.orders.findMany({
      where: conditions,
      with: {
        customer: true,
        product: true,
        serviceAgent: true,
        payments: true,
      },
    });
  }

  // Process results to ensure proper data structure and handle nulls
  const processedResults = results.map((order) => {
    // Ensure all fields are properly structured
    const processedOrder = {
      id: order.id,
      customerId: order.customerId,
      productId: order.productId,
      type: order.type,
      status: order.status,
      totalAmount: order.totalAmount,
      paymentStatus: order.paymentStatus,
      serviceAgentId: order.serviceAgentId || null,
      installationDate: order.installationDate || null,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      customer: order.customer ? {
        id: order.customer.id,
        name: order.customer.name || null,
        phone: order.customer.phone,
        email: order.customer.email || null,
        address: order.customer.address || null,
        alternativePhone: order.customer.alternativePhone || null,
        role: order.customer.role,
        franchiseAreaId: order.customer.franchiseAreaId || null,
        locationLatitude: order.customer.locationLatitude || null,
        locationLongitude: order.customer.locationLongitude || null,
        hasOnboarded: order.customer.hasOnboarded || false,
        isActive: order.customer.isActive,
        firebaseUid: order.customer.firebaseUid || null,
        createdAt: order.customer.createdAt,
        updatedAt: order.customer.updatedAt,
      } : null,
      serviceAgent: order.serviceAgent ? {
        id: order.serviceAgent.id,
        name: order.serviceAgent.name || null,
        phone: order.serviceAgent.phone,
        email: order.serviceAgent.email || null,
        address: order.serviceAgent.address || null,
        alternativePhone: order.serviceAgent.alternativePhone || null,
        role: order.serviceAgent.role,
        franchiseAreaId: order.serviceAgent.franchiseAreaId || null,
        locationLatitude: order.serviceAgent.locationLatitude || null,
        locationLongitude: order.serviceAgent.locationLongitude || null,
        hasOnboarded: order.serviceAgent.hasOnboarded || false,
        isActive: order.serviceAgent.isActive,
        firebaseUid: order.serviceAgent.firebaseUid || null,
        createdAt: order.serviceAgent.createdAt,
        updatedAt: order.serviceAgent.updatedAt,
      } : null,
      product: order.product ? {
        ...order.product,
        images: parseJsonSafe<string[]>(order.product.images as any, [])
      } : null,
      payments: order.payments || []
    };

    return processedOrder;
  });

  return processedResults;
}

// Get orders for a specific user - Updated to show meaningful orders
export async function getUserOrders(userId: string, status?: OrderStatus, type?: OrderType) {
  const fastify = getFastifyInstance();

  // Define meaningful order statuses for users (payment completed and above)
  const meaningfulStatuses = [
    OrderStatus.PAYMENT_COMPLETED,
    OrderStatus.ASSIGNED,
    OrderStatus.INSTALLATION_PENDING,
    OrderStatus.INSTALLED,
    OrderStatus.COMPLETED
  ];

  let conditions = eq(orders.customerId, userId);

  // If no specific status is requested, filter to meaningful statuses
  if (!status) {
    conditions = and(
      conditions,
      inArray(orders.status, meaningfulStatuses)
    );
  } else {
    conditions = and(conditions, eq(orders.status, status));
  }

  if (type) {
    conditions = and(conditions, eq(orders.type, type));
  }

  const results = await fastify.db.query.orders.findMany({
    where: conditions,
    with: {
      product: true,
      serviceAgent: true,
      payments: true,
    },
    orderBy: (orders, { desc }) => [desc(orders.createdAt)] // Show newest first
  });

  // Process results to ensure proper data structure
  const processedResults = results.map((order) => {
    return {
      id: order.id,
      customerId: order.customerId,
      productId: order.productId,
      type: order.type,
      status: order.status,
      totalAmount: order.totalAmount,
      paymentStatus: order.paymentStatus,
      serviceAgentId: order.serviceAgentId || null,
      installationDate: order.installationDate || null,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      serviceAgent: order.serviceAgent ? {
        id: order.serviceAgent.id,
        name: order.serviceAgent.name || null,
        phone: order.serviceAgent.phone,
        email: order.serviceAgent.email || null,
        address: order.serviceAgent.address || null,
        alternativePhone: order.serviceAgent.alternativePhone || null,
        role: order.serviceAgent.role,
        franchiseAreaId: order.serviceAgent.franchiseAreaId || null,
        locationLatitude: order.serviceAgent.locationLatitude || null,
        locationLongitude: order.serviceAgent.locationLongitude || null,
        hasOnboarded: order.serviceAgent.hasOnboarded || false,
        isActive: order.serviceAgent.isActive,
        firebaseUid: order.serviceAgent.firebaseUid || null,
        createdAt: order.serviceAgent.createdAt,
        updatedAt: order.serviceAgent.updatedAt,
      } : null,
      product: order.product ? {
        ...order.product,
        images: parseJsonSafe<string[]>(order.product.images as any, [])
      } : null,
      payments: order.payments || []
    };
  });

  return processedResults;
}

// Get order by ID
export async function getOrderById(id: string) {
  const fastify = getFastifyInstance();

  const result = await fastify.db.query.orders.findFirst({
    where: eq(orders.id, id),
    with: {
      customer: true,
      product: true,
      serviceAgent: true,
      payments: true,
    },
  });

  // Parse product images if product exists
  if (result && result.product) {
    result.product.images = parseJsonSafe<string[]>(result.product.images as any, []);
  }

  return result;
}

// Get available service agents for order assignment
export async function getAvailableServiceAgentsForOrder(orderId: string) {
  const fastify = getFastifyInstance();

  console.log('Getting available service agents for order:', orderId);

  const order = await getOrderById(orderId);
  if (!order) {
    throw notFound('Order');
  }

  // Get customer to find franchise area
  const customer = await fastify.db.query.users.findFirst({
    where: eq(users.id, order.customerId)
  });

  if (!customer) {
    throw notFound('Customer');
  }

  const franchiseAreaId = customer.franchiseAreaId;
  console.log('Customer franchise area ID:', franchiseAreaId);

  // Get franchise-specific and global service agents using corrected query
  let whereConditions;
  
  if (franchiseAreaId) {
    // Get agents from specific franchise area OR global agents (franchise_area_id IS NULL)
    whereConditions = and(
      eq(users.role, UserRole.SERVICE_AGENT),
      eq(users.isActive, true),
      or(
        eq(users.franchiseAreaId, franchiseAreaId),
        isNull(users.franchiseAreaId) // Use isNull() instead of eq(users.franchiseAreaId, null)
      )
    );
  } else {
    // Only global agents if customer has no franchise area
    whereConditions = and(
      eq(users.role, UserRole.SERVICE_AGENT),
      eq(users.isActive, true),
      isNull(users.franchiseAreaId) // Use isNull() instead of eq(users.franchiseAreaId, null)
    );
  }

  console.log('Built where conditions for service agents query');

  const availableAgents = await fastify.db.query.users.findMany({
    where: whereConditions,
    with: {
      franchiseArea: true
    }
  });

  console.log(`Found ${availableAgents.length} available agents:`, availableAgents.map(a => ({
    id: a.id,
    name: a.name,
    franchiseAreaId: a.franchiseAreaId,
    isGlobal: !a.franchiseAreaId
  })));

  // Format the response with additional info
  return availableAgents.map(agent => ({
    id: agent.id,
    name: agent.name,
    phone: agent.phone,
    email: agent.email,
    franchiseAreaId: agent.franchiseAreaId,
    franchiseAreaName: agent.franchiseArea?.name || 'Global Agent',
    isGlobalAgent: !agent.franchiseAreaId,
    createdAt: agent.createdAt,
    // Add any additional stats if needed
    activeOrdersCount: 0, // This could be calculated if needed
    completedOrdersCount: 0 // This could be calculated if needed
  }));
}

// Create a new order with user details
export async function createOrder(data: {
  productId: string;
  customerId: string;
  type: OrderType;
  installationDate?: Date;
  userDetails?: {
    name: string;
    email?: string;
    address?: string;
    phone?: string;
    alternativePhone?: string;
    latitude?: number;
    longitude?: number;
  };
}) {
  const fastify = getFastifyInstance();

  // Get product info to calculate total amount
  const product = await fastify.db.query.products.findFirst({
    where: eq(products.id, data.productId),
  });

  if (!product) {
    throw notFound('Product');
  }

  // Validate product availability for the order type
  if (data.type === OrderType.PURCHASE && !product.isPurchasable) {
    throw badRequest('This product is not available for purchase');
  }

  if (data.type === OrderType.RENTAL && !product.isRentable) {
    throw badRequest('This product is not available for rental');
  }

  // Get customer info
  const customer = await userService.getUserById(data.customerId);
  if (!customer) {
    throw notFound('Customer');
  }

  const orderId = await await generateId('ord');

  // Calculate total amount based on order type
  const totalAmount = data.type === OrderType.PURCHASE
    ? product.buyPrice
    : product.deposit; // For rentals, initial payment is the deposit amount

  // Create the order in a transaction
  const createdOrder = await fastify.db.transaction(async (tx) => {
    // Get updated customer info for franchise area
    const updatedCustomer = await tx.query.users.findFirst({
      where: eq(users.id, data.customerId)
    });

    if (!updatedCustomer?.franchiseAreaId) {
      throw badRequest('No franchise area available for this location. Please contact support.');
    }

    // Create the order
    await tx.insert(orders).values({
      id: orderId,
      customerId: data.customerId,
      productId: data.productId,
      type: data.type,
      status: OrderStatus.CREATED,
      totalAmount,
      paymentStatus: PaymentStatus.PENDING,
      installationDate: data.installationDate?.toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Create payment record
    const paymentId = await await generateId('pay');
    if (data.type === OrderType.RENTAL) {
      // For rentals, create deposit payment record
      await tx.insert(payments).values({
        id: paymentId,
        orderId,
        amount: product.deposit,
        type: PaymentType.DEPOSIT,
        status: PaymentStatus.PENDING,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    } else {
      // For purchases, create purchase payment record
      await tx.insert(payments).values({
        id: paymentId,
        orderId,
        amount: product.buyPrice,
        type: PaymentType.PURCHASE,
        status: PaymentStatus.PENDING,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    return orderId;
  });

  // Send notification to customer
  try {
    await notificationService.send(
      data.customerId,
      'New Order Created',
      `Your order for ${product.name} has been created. Please proceed to payment.`,
      NotificationType.ORDER_CONFIRMATION,
      [NotificationChannel.PUSH, NotificationChannel.EMAIL],
      orderId,
      'order'
    );
  } catch (error) {
    fastify.log.error(`Failed to send notification: ${error}`);
  }

  return await getOrderById(orderId);
}

// Update order status
export async function updateOrderStatus(id: string, status: OrderStatus, user: { userId: string; role: UserRole; franchiseAreaId?: string }) {
  const fastify = getFastifyInstance();

  const order = await getOrderById(id);
  if (!order) {
    throw notFound('Order');
  }

  // Check if user has permission based on role
  if (user.role === UserRole.SERVICE_AGENT && order.serviceAgentId !== user.userId) {
    throw badRequest('You are not assigned to this order');
  }

  if (user.role === UserRole.FRANCHISE_OWNER) {
    // Check if order is in the franchise owner's area
    const customer = await userService.getUserById(order.customerId);
    if (!customer || customer.franchiseAreaId !== user.franchiseAreaId) {
      throw badRequest('This order is not in your franchise area');
    }
  }

  // Validate status transitions
  if (!isValidStatusTransition(order.status, status)) {
    throw badRequest(`Cannot change order status from ${order.status} to ${status}`);
  }

  // Update the order status
  await fastify.db
    .update(orders)
    .set({
      status,
      updatedAt: new Date().toISOString()
    })
    .where(eq(orders.id, id));

  // Send notification to customer
  try {
    await notificationService.send(
      order.customerId,
      'Order Status Updated',
      `Your order status has been updated to ${status}.`,
      NotificationType.STATUS_UPDATE,
      [NotificationChannel.PUSH, NotificationChannel.EMAIL],
      id,
      'order'
    );
  } catch (error) {
    fastify.log.error(`Failed to send notification: ${error}`);
  }

  // If the order is installed and it's a rental, create rental record
  if (status === OrderStatus.INSTALLED && order.type === OrderType.RENTAL) {
    await createRentalFromOrder(id);
  }

  return getOrderById(id);
}

// Validate status transitions
function isValidStatusTransition(currentStatus: OrderStatus, newStatus: OrderStatus): boolean {
  const validTransitions: Record<OrderStatus, OrderStatus[]> = {
    [OrderStatus.CREATED]: [OrderStatus.PAYMENT_PENDING, OrderStatus.CANCELLED],
    [OrderStatus.PAYMENT_PENDING]: [OrderStatus.PAYMENT_COMPLETED, OrderStatus.CANCELLED],
    [OrderStatus.PAYMENT_COMPLETED]: [OrderStatus.ASSIGNED, OrderStatus.INSTALLATION_PENDING],
    [OrderStatus.ASSIGNED]: [OrderStatus.INSTALLATION_PENDING, OrderStatus.INSTALLED],
    [OrderStatus.INSTALLATION_PENDING]: [OrderStatus.INSTALLED, OrderStatus.ASSIGNED],
    [OrderStatus.INSTALLED]: [OrderStatus.COMPLETED],
    [OrderStatus.CANCELLED]: [], // Cannot transition from cancelled
    [OrderStatus.COMPLETED]: [], // Cannot transition from completed
  };

  return validTransitions[currentStatus]?.includes(newStatus) || false;
}

// Assign service agent to order
export async function assignServiceAgent(id: string, serviceAgentId: string, user: { userId: string; role: UserRole; franchiseAreaId?: string }) {
  const fastify = getFastifyInstance();

  const order = await getOrderById(id);
  if (!order) {
    throw notFound('Order');
  }

  // Only allow assignment if payment is completed
  if (order.paymentStatus !== PaymentStatus.COMPLETED) {
    throw badRequest('Cannot assign service agent until payment is completed');
  }

  // Validate that service agent exists and is active
  const serviceAgent = await userService.getUserById(serviceAgentId);
  if (!serviceAgent || !serviceAgent.isActive || serviceAgent.role !== UserRole.SERVICE_AGENT) {
    throw badRequest('Invalid service agent');
  }

  // Get customer to check franchise area
  const customer = await userService.getUserById(order.customerId);
  if (!customer) {
    throw badRequest('Customer not found');
  }

  // Check if assignment is valid based on user role and franchise area
  if (user.role === UserRole.FRANCHISE_OWNER) {
    // Franchise owner can only assign agents from their area or global agents
    if (serviceAgent.franchiseAreaId && serviceAgent.franchiseAreaId !== user.franchiseAreaId) {
      throw badRequest('Service agent is not in your franchise area');
    }

    // Also check if the order is in this franchise area
    if (customer.franchiseAreaId !== user.franchiseAreaId) {
      throw badRequest('This order is not in your franchise area');
    }
  }

  // For admin, allow assignment of any agent to any order
  // For franchise-specific agents, ensure they can serve this customer's area
  if (serviceAgent.franchiseAreaId && customer.franchiseAreaId && 
      serviceAgent.franchiseAreaId !== customer.franchiseAreaId) {
    throw badRequest('Service agent cannot serve this customer\'s franchise area');
  }

  // Update the order
  await fastify.db
    .update(orders)
    .set({
      serviceAgentId,
      status: OrderStatus.ASSIGNED,
      updatedAt: new Date().toISOString()
    })
    .where(eq(orders.id, id));

  // Send notifications
  try {
    // Notify customer
    await notificationService.send(
      order.customerId,
      'Service Agent Assigned',
      `A service agent has been assigned to your order. They will contact you soon for installation.`,
      NotificationType.ASSIGNMENT_NOTIFICATION,
      [NotificationChannel.PUSH, NotificationChannel.EMAIL],
      id,
      'order'
    );

    // Notify service agent
    await notificationService.send(
      serviceAgentId,
      'New Order Assignment',
      `You have been assigned to a new ${order.type} order for ${order.product?.name}.`,
      NotificationType.ASSIGNMENT_NOTIFICATION,
      [NotificationChannel.PUSH, NotificationChannel.EMAIL],
      id,
      'order'
    );
  } catch (error) {
    fastify.log.error(`Failed to send notification: ${error}`);
  }

  return getOrderById(id);
}

// Notify all available service agents about new order
export async function notifyAvailableServiceAgents(orderId: string, franchiseAreaId?: string) {
  const fastify = getFastifyInstance();

  try {
    const order = await getOrderById(orderId);
    if (!order) {
      throw notFound('Order');
    }

    // Get all available service agents (franchise + global)
    const availableAgents = await franchiseService.getAllAvailableServiceAgents(franchiseAreaId);

    // Send notification to all available agents
    for (const agent of availableAgents) {
      try {
        await notificationService.send(
          agent.id,
          'New Order Available',
          `A new ${order.type} order for ${order.product?.name} is available for assignment in your area.`,
          NotificationType.SERVICE_REQUEST,
          [NotificationChannel.PUSH, NotificationChannel.EMAIL],
          orderId,
          'order'
        );
      } catch (error) {
        fastify.log.error(`Failed to send notification to agent ${agent.id}: ${error}`);
      }
    }

    fastify.log.info(`Notified ${availableAgents.length} service agents about order ${orderId}`);
  } catch (error) {
    fastify.log.error(`Failed to notify service agents about order ${orderId}: ${error}`);
  }
}

// Update installation date
export async function updateInstallationDate(id: string, installationDate: Date, user: { userId: string; role: UserRole; franchiseAreaId?: string }) {
  const fastify = getFastifyInstance();

  const order = await getOrderById(id);
  if (!order) {
    throw notFound('Order');
  }

  // Check permissions
  if (user.role === UserRole.SERVICE_AGENT && order.serviceAgentId !== user.userId) {
    throw badRequest('You are not assigned to this order');
  }

  if (user.role === UserRole.FRANCHISE_OWNER) {
    // Check if order is in the franchise owner's area
    const customer = await userService.getUserById(order.customerId);
    if (!customer || customer.franchiseAreaId !== user.franchiseAreaId) {
      throw badRequest('This order is not in your franchise area');
    }
  }

  // Validate installation date is in the future
  if (installationDate <= new Date()) {
    throw badRequest('Installation date must be in the future');
  }

  // Update the order
  await fastify.db
    .update(orders)
    .set({
      installationDate: installationDate.toISOString(),
      status: OrderStatus.INSTALLATION_PENDING,
      updatedAt: new Date().toISOString()
    })
    .where(eq(orders.id, id));

  // Send notification to customer
  try {
    await notificationService.send(
      order.customerId,
      'Installation Date Scheduled',
      `Your installation has been scheduled for ${installationDate.toLocaleDateString()}.`,
      NotificationType.STATUS_UPDATE,
      [NotificationChannel.PUSH, NotificationChannel.EMAIL],
      id,
      'order'
    );
  } catch (error) {
    fastify.log.error(`Failed to send notification: ${error}`);
  }

  return getOrderById(id);
}

// Initiate payment for an order
export async function initiatePayment(orderId: string) {
  const fastify = getFastifyInstance();

  console.log('came here in intiate payment')

  const order = await getOrderById(orderId);
  if (!order) {
    throw notFound('Order');
  }

  // Check if payment is already completed
  if (order.paymentStatus === PaymentStatus.COMPLETED) {
    throw badRequest('Payment for this order has already been completed');
  }

  // Check if order is in a valid state for payment
  if (![OrderStatus.CREATED, OrderStatus.PAYMENT_PENDING].includes(order.status)) {
    throw badRequest('Order is not in a valid state for payment');
  }

  // Get the pending payment record
  const pendingPayment = await fastify.db.query.payments.findFirst({
    where: and(
      eq(payments.orderId, orderId),
      eq(payments.status, PaymentStatus.PENDING)
    )
  });

  if (!pendingPayment) {
    throw notFound('No pending payment found for this order');
  }

  console.log('came here ')
  // Create Razorpay order
  const razorpayOrder = await fastify.razorpay.orders.create({
    amount: pendingPayment.amount * 100, // Amount in paise
    currency: 'INR',
    receipt: orderId,
    notes: {
      orderType: order.type,
      productName: order.product?.name || 'Water Purifier',
      customerId: order.customerId,
      paymentId: pendingPayment.id
    }
  });

  console.log('came here too')
  // Update payment record with Razorpay order ID
  await fastify.db
    .update(payments)
    .set({
      razorpayOrderId: razorpayOrder.id,
      updatedAt: new Date().toISOString()
    })
    .where(eq(payments.id, pendingPayment.id));

  // Update order status to payment pending
  await fastify.db
    .update(orders)
    .set({
      status: OrderStatus.PAYMENT_PENDING,
      updatedAt: new Date().toISOString()
    })
    .where(eq(orders.id, orderId));

  // Return payment information for frontend
  return {
    orderId,
    paymentId: pendingPayment.id,
    razorpayOrderId: razorpayOrder.id,
    amount: pendingPayment.amount * 100, // in paise
    currency: 'INR',
    productName: order.product?.name || 'Water Purifier',
    customerName: order.customer?.name || '',
    customerEmail: order.customer?.email || '',
    customerPhone: order.customer?.phone || ''
  };
}

// Verify payment
export async function verifyPayment(
  orderId: string,
  razorpayPaymentId: string,
  razorpayOrderId: string,
  razorpaySignature: string
): Promise<boolean> {
  const fastify = getFastifyInstance();

  const order = await getOrderById(orderId);
  if (!order) {
    throw notFound('Order');
  }

  // Get the payment record
  const payment = await fastify.db.query.payments.findFirst({
    where: and(
      eq(payments.orderId, orderId),
      eq(payments.razorpayOrderId, razorpayOrderId)
    )
  });

  if (!payment) {
    throw notFound('Payment record not found');
  }

  // Verify the signature
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keySecret) {
    throw serverError('Razorpay key not configured');
  }

  try {
    const expectedSignature = crypto
      .createHmac('sha256', keySecret)
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest('hex');

    const isVerified = expectedSignature === razorpaySignature;

    if (isVerified) {
      // Update payment status in a transaction
      await fastify.db.transaction(async (tx) => {
        // Update payment status
        await tx
          .update(payments)
          .set({
            razorpayPaymentId,
            status: PaymentStatus.COMPLETED,
            updatedAt: new Date().toISOString()
          })
          .where(eq(payments.id, payment.id));

        // Update order status
        await tx
          .update(orders)
          .set({
            paymentStatus: PaymentStatus.COMPLETED,
            status: OrderStatus.PAYMENT_COMPLETED,
            updatedAt: new Date().toISOString()
          })
          .where(eq(orders.id, orderId));
      });

      // Send notification to customer
      try {
        await notificationService.send(
          order.customerId,
          'Payment Successful',
          `Your payment for order #${orderId} has been received successfully. We will assign a service agent soon.`,
          NotificationType.PAYMENT_SUCCESS,
          [NotificationChannel.PUSH, NotificationChannel.EMAIL],
          orderId,
          'order'
        );
      } catch (error) {
        fastify.log.error(`Failed to send notification: ${error}`);
      }

      // Notify all available service agents about the new paid order
      const customer = await userService.getUserById(order.customerId);
      await notifyAvailableServiceAgents(orderId, customer?.franchiseAreaId);

      return true;
    } else {
      // Update payment status to failed
      await fastify.db
        .update(payments)
        .set({
          status: PaymentStatus.FAILED,
          updatedAt: new Date().toISOString()
        })
        .where(eq(payments.id, payment.id));

      // Send notification about failed payment
      try {
        await notificationService.send(
          order.customerId,
          'Payment Failed',
          `Your payment for order #${orderId} could not be verified. Please try again.`,
          NotificationType.PAYMENT_FAILURE,
          [NotificationChannel.PUSH, NotificationChannel.EMAIL],
          orderId,
          'order'
        );
      } catch (error) {
        fastify.log.error(`Failed to send notification: ${error}`);
      }

      return false;
    }
  } catch (error) {
    fastify.log.error(`Payment verification error: ${error}`);

    // Update payment status to failed
    await fastify.db
      .update(payments)
      .set({
        status: PaymentStatus.FAILED,
        updatedAt: new Date().toISOString()
      })
      .where(eq(payments.id, payment.id));

    return false;
  }
}

// Create rental record from a completed order
async function createRentalFromOrder(orderId: string) {
  const fastify = getFastifyInstance();

  const order = await getOrderById(orderId);
  if (!order || order.type !== OrderType.RENTAL) {
    return null;
  }

  const product = await fastify.db.query.products.findFirst({
    where: eq(products.id, order.productId),
  });

  if (!product) {
    return null;
  }

  const now = new Date();
  const threeMonthsLater = new Date();
  threeMonthsLater.setMonth(threeMonthsLater.getMonth() + 3); // Minimum 3 months tenure

  // Create rental record
  const rentalId = await await generateId('rent');
  await fastify.db.insert(rentals).values({
    id: rentalId,
    orderId: order.id,
    customerId: order.customerId,
    productId: order.productId,
    status: RentalStatus.ACTIVE,
    startDate: now.toISOString(),
    currentPeriodStartDate: now.toISOString(),
    currentPeriodEndDate: threeMonthsLater.toISOString(), // 3 months minimum tenure
    monthlyAmount: product.rentPrice,
    depositAmount: product.deposit,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });

  // Send notification to customer
  try {
    await notificationService.send(
      order.customerId,
      'Rental Started',
      `Your rental for ${product.name} has been activated. The minimum tenure period is 3 months, ending on ${threeMonthsLater.toLocaleDateString()}.`,
      NotificationType.STATUS_UPDATE,
      [NotificationChannel.PUSH, NotificationChannel.EMAIL],
      rentalId,
      'rental'
    );
  } catch (error) {
    fastify.log.error(`Failed to send notification: ${error}`);
  }

  return rentalId;
}