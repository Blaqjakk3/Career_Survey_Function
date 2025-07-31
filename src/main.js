import { Client, Databases, Query } from 'node-appwrite';
import { GoogleGenerativeAI } from '@google/generative-ai';

export default async function (context) {
  try {
    // Access environment variables correctly for Appwrite Cloud Functions
    const APPWRITE_ENDPOINT = process.env.APPWRITE_ENDPOINT;
    const APPWRITE_PROJECT_ID = process.env.APPWRITE_PROJECT_ID;
    const APPWRITE_API_KEY = process.env.APPWRITE_API_KEY;
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    const DATABASE_ID = process.env.DATABASE_ID || 'career4me';
    const TALENTS_COLLECTION_ID = process.env.TALENTS_COLLECTION_ID || 'talents';
    const CAREER_PATHS_COLLECTION_ID = process.env.CAREER_PATHS_COLLECTION_ID || 'careerPaths';

    // Get user ID and survey answers from the request payload
    let userId = null;
    let surveyAnswers = null;
    
    // Parse the request payload
    try {
      const payload = JSON.parse(context.req.body || '{}');
      userId = payload.userId;
      surveyAnswers = payload.surveyAnswers;
    } catch (e) {
      context.error('Failed to parse request payload:', e);
    }

    // Try to get user ID from JWT token in headers if not in payload
    if (!userId) {
      try {
        if (context.req.headers['x-appwrite-user-id']) {
          userId = context.req.headers['x-appwrite-user-id'];
        } else if (context.req.headers['authorization']) {
          // If we have an auth header, we can get the user from the client
          const userClient = new Client()
            .setEndpoint(APPWRITE_ENDPOINT)
            .setProject(APPWRITE_PROJECT_ID);
          
          // Set the session from the authorization header
          const authHeader = context.req.headers['authorization'];
          if (authHeader.startsWith('Bearer ')) {
            const sessionId = authHeader.substring(7);
            userClient.setSession(sessionId);
            
            const { Account } = await import('node-appwrite');
            const userAccount = new Account(userClient);
            const user = await userAccount.get();
            userId = user.$id;
          }
        }
      } catch (authError) {
        context.log('Auth error:', authError);
      }
    }

    // Use context.log for better logging experience
    context.log('Environment variables loaded:', {
      hasEndpoint: !!APPWRITE_ENDPOINT,
      hasProjectId: !!APPWRITE_PROJECT_ID,
      hasApiKey: !!APPWRITE_API_KEY,
      hasGeminiKey: !!GEMINI_API_KEY,
      userId: userId || 'not found',
      hasSurveyAnswers: !!surveyAnswers
    });

    // Validate required environment variables
    if (!APPWRITE_ENDPOINT || !APPWRITE_PROJECT_ID || !APPWRITE_API_KEY || !GEMINI_API_KEY) {
      context.error("Missing required environment variables", {
        APPWRITE_ENDPOINT: !!APPWRITE_ENDPOINT,
        APPWRITE_PROJECT_ID: !!APPWRITE_PROJECT_ID,
        APPWRITE_API_KEY: !!APPWRITE_API_KEY,
        GEMINI_API_KEY: !!GEMINI_API_KEY
      });
      throw new Error("Missing required environment variables");
    }

    if (!userId) {
      context.error("No user ID found in request context or payload");
      throw new Error("User authentication required");
    }

    // Initialize Appwrite client
    const client = new Client()
      .setEndpoint(APPWRITE_ENDPOINT)
      .setProject(APPWRITE_PROJECT_ID)
      .setKey(APPWRITE_API_KEY);

    // Initialize Gemini AI
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ 
      model: "gemini-2.5-flash",
      config: { 
        thinkingConfig: {
          thinkingBudget: 0,
        },
      },
    });

    const databases = new Databases(client);

    context.log('Fetching user data for userId:', userId);

    // Get user data for career stage and basic info
    const user = await databases.listDocuments(
      DATABASE_ID,
      TALENTS_COLLECTION_ID,
      [Query.equal("talentId", userId)]
    );

    if (user.documents.length === 0) {
      context.error("User not found for userId:", userId);
      throw new Error("User not found");
    }

    const userData = user.documents[0];
    const careerStage = userData.careerStage;

    context.log('User data found:', {
      careerStage,
      currentPath: userData.currentPath,
      hasSurveyAnswers: !!surveyAnswers
    });

    // Get ALL career paths with pagination to ensure we get all paths
    let allCareerPaths = [];
    let offset = 0;
    const limit = 100; // Appwrite's default limit
    
    do {
      const careerPathsBatch = await databases.listDocuments(
        DATABASE_ID,
        CAREER_PATHS_COLLECTION_ID,
        [Query.limit(limit), Query.offset(offset)]
      );
      
      allCareerPaths = allCareerPaths.concat(careerPathsBatch.documents);
      offset += limit;
      
      // Break if we got fewer documents than the limit (meaning we're at the end)
      if (careerPathsBatch.documents.length < limit) {
        break;
      }
    } while (true);

    if (allCareerPaths.length === 0) {
      context.error("No career paths found in database");
      throw new Error("No career paths found in database");
    }

    context.log('Total career paths found:', allCareerPaths.length);

    // Function to map survey answers to user profile data
    const mapSurveyAnswersToProfile = (answers, careerStage, storedCurrentPath = null) => {
      const profile = {
        careerStage,
        education: '',
        program: '',
        currentSkills: [],
        interestedSkills: [],
        interests: [],
        interestedFields: [],
        workEnvironment: '',
        currentPath: storedCurrentPath || '', // Use stored path as fallback
        yearsExperience: '',
        seniorityLevel: '',
        careerGoals: '',
        reasonForChange: '',
        changeUrgency: '',
        currentWorkEnvironment: '',
        preferredWorkEnvironment: ''
      };

      // Map common fields across all career stages
      if (answers.educationLevel) profile.education = answers.educationLevel;
      if (answers.program) profile.program = answers.program;
      
      // Handle skills - convert single answers to arrays for consistency
      if (answers.currentSkills) {
        profile.currentSkills = Array.isArray(answers.currentSkills) 
          ? answers.currentSkills 
          : [answers.currentSkills];
      }
      if (answers.interestedSkills) {
        profile.interestedSkills = Array.isArray(answers.interestedSkills) 
          ? answers.interestedSkills 
          : [answers.interestedSkills];
      }
      if (answers.mainInterests) {
        profile.interests = Array.isArray(answers.mainInterests) 
          ? answers.mainInterests 
          : [answers.mainInterests];
      }
      if (answers.interestedFields) {
        profile.interestedFields = Array.isArray(answers.interestedFields) 
          ? answers.interestedFields 
          : [answers.interestedFields];
      }

      // Stage-specific mappings
      if (careerStage === 'Pathfinder') {
        if (answers.workEnvironment) profile.workEnvironment = answers.workEnvironment;
      } else if (careerStage === 'Trailblazer') {
        if (answers.currentPath) profile.currentPath = answers.currentPath;
        if (answers.yearsExperience) profile.yearsExperience = answers.yearsExperience;
        if (answers.seniorityLevel) profile.seniorityLevel = answers.seniorityLevel;
        if (answers.careerGoals) profile.careerGoals = answers.careerGoals;
      } else if (careerStage === 'Horizon Changer') {
        if (answers.currentPath) profile.currentPath = answers.currentPath;
        if (answers.yearsExperience) profile.yearsExperience = answers.yearsExperience;
        if (answers.seniorityLevel) profile.seniorityLevel = answers.seniorityLevel;
        if (answers.currentWorkEnvironment) profile.currentWorkEnvironment = answers.currentWorkEnvironment;
        if (answers.preferredWorkEnvironment) profile.preferredWorkEnvironment = answers.preferredWorkEnvironment;
        if (answers.reasonForChange) profile.reasonForChange = answers.reasonForChange;
        if (answers.changeUrgency) profile.changeUrgency = answers.changeUrgency;
      }

      return profile;
    };

    // Use survey answers if provided, otherwise fall back to stored user data
    let userProfile;
    if (surveyAnswers && Object.keys(surveyAnswers).length > 0) {
      context.log('Using survey answers for recommendation');
      userProfile = mapSurveyAnswersToProfile(surveyAnswers, careerStage, userData.currentPath);
      
      // Update the talents collection with the new survey data
      const updateData = {};
      
      // Map survey answers to database fields where appropriate
      if (surveyAnswers.educationLevel && !['High School', 'Some College'].includes(surveyAnswers.educationLevel)) {
        if (surveyAnswers.program && !updateData.degrees) updateData.degrees = [surveyAnswers.program];
      }
      if (surveyAnswers.currentSkills) {
        updateData.skills = Array.isArray(surveyAnswers.currentSkills) 
          ? surveyAnswers.currentSkills 
          : [surveyAnswers.currentSkills];
      }
      if (surveyAnswers.mainInterests) {
        updateData.interests = Array.isArray(surveyAnswers.mainInterests) 
          ? surveyAnswers.mainInterests 
          : [surveyAnswers.mainInterests];
      }
      if (surveyAnswers.interestedFields) {
        updateData.interestedFields = Array.isArray(surveyAnswers.interestedFields) 
          ? surveyAnswers.interestedFields 
          : [surveyAnswers.interestedFields];
      }
      if (surveyAnswers.currentPath) updateData.currentPath = surveyAnswers.currentPath;
      if (surveyAnswers.seniorityLevel) updateData.currentSeniorityLevel = surveyAnswers.seniorityLevel;
      
      // Update the user document with relevant survey data
      if (Object.keys(updateData).length > 0) {
        try {
          await databases.updateDocument(
            DATABASE_ID,
            TALENTS_COLLECTION_ID,
            userData.$id,
            updateData
          );
          context.log('Updated user profile with survey data');
        } catch (updateError) {
          context.log('Error updating user profile:', updateError);
        }
      }
    } else {
      context.log('Using stored user data for recommendation');
      userProfile = {
        careerStage,
        education: userData.degrees?.join(', ') || 'Not specified',
        currentSkills: userData.skills || [],
        interests: userData.interests || [],
        interestedFields: userData.interestedFields || [],
        currentPath: userData.currentPath || 'Not specified',
        seniorityLevel: userData.currentSeniorityLevel || 'Not specified'
      };
    }

    // Enhanced filtering function for different career stages
    const filterRelevantCareerPaths = (careerPaths, userProfile) => {
      const relevantPaths = [];
      const userInterests = userProfile.interests.map(i => i.toLowerCase());
      const userFields = userProfile.interestedFields.map(f => f.toLowerCase());
      const userSkills = userProfile.currentSkills.concat(userProfile.interestedSkills || []).map(s => s.toLowerCase());
      
      // Special handling for Trailblazer - prioritize current path
      let currentPathMatch = null;
      if (careerStage === 'Trailblazer' && userProfile.currentPath && userProfile.currentPath !== 'Not specified') {
        currentPathMatch = careerPaths.find(path => 
          path.title.toLowerCase().includes(userProfile.currentPath.toLowerCase()) ||
          userProfile.currentPath.toLowerCase().includes(path.title.toLowerCase())
        );
        if (currentPathMatch) {
          context.log('Found current path match for Trailblazer:', currentPathMatch.title);
        }
      }
      
      for (const path of careerPaths) {
        let relevanceScore = 0;
        
        // Special boost for Trailblazer's current path
        if (careerStage === 'Trailblazer' && currentPathMatch && path.$id === currentPathMatch.$id) {
          relevanceScore += 50; // High boost to ensure it's at the top
          context.log('Boosting current path for Trailblazer:', path.title);
        }
        
        // Check interests match
        if (path.requiredInterests && Array.isArray(path.requiredInterests)) {
          const pathInterests = path.requiredInterests.map(i => i.toLowerCase());
          const interestMatches = pathInterests.filter(pi => 
            userInterests.some(ui => ui.includes(pi) || pi.includes(ui))
          ).length;
          relevanceScore += interestMatches * 3;
        }
        
        // Check skills match
        if (path.requiredSkills && Array.isArray(path.requiredSkills)) {
          const pathSkills = path.requiredSkills.map(s => s.toLowerCase());
          const skillMatches = pathSkills.filter(ps => 
            userSkills.some(us => us.includes(ps) || ps.includes(us))
          ).length;
          relevanceScore += skillMatches * 2;
        }
        
        // Check industry/field match
        if (path.industry) {
          const pathIndustry = path.industry.toLowerCase();
          if (userFields.some(uf => uf.includes(pathIndustry) || pathIndustry.includes(uf))) {
            relevanceScore += 4;
          }
        }
        
        // Check degree requirements match
        if (path.suggestedDegrees && Array.isArray(path.suggestedDegrees) && userProfile.program) {
          const userProgram = userProfile.program.toLowerCase();
          const degreeMatches = path.suggestedDegrees.some(deg => 
            deg.toLowerCase().includes(userProgram) || userProgram.includes(deg.toLowerCase())
          );
          if (degreeMatches) relevanceScore += 3;
        }
        
        // For Horizon Changer, slightly boost paths that are different from current path
        if (careerStage === 'Horizon Changer' && userProfile.currentPath && userProfile.currentPath !== 'Not specified') {
          const isDifferentPath = !path.title.toLowerCase().includes(userProfile.currentPath.toLowerCase()) &&
                                !userProfile.currentPath.toLowerCase().includes(path.title.toLowerCase());
          if (isDifferentPath && relevanceScore > 0) {
            relevanceScore += 2; // Small boost for different paths
          }
        }
        
        // Include paths with any relevance score > 0, or if we don't have enough matches, include some random ones
        if (relevanceScore > 0) {
          relevantPaths.push({ ...path, relevanceScore });
        }
      }
      
      // Sort by relevance score and take top candidates
      relevantPaths.sort((a, b) => b.relevanceScore - a.relevanceScore);
      
      // If we have fewer than 15 relevant paths, add some random ones to ensure variety
      if (relevantPaths.length < 15) {
        const remainingPaths = careerPaths.filter(path => 
          !relevantPaths.some(rp => rp.$id === path.$id)
        );
        const randomPaths = remainingPaths
          .sort(() => Math.random() - 0.5)
          .slice(0, 15 - relevantPaths.length)
          .map(path => ({ ...path, relevanceScore: 0 }));
        relevantPaths.push(...randomPaths);
      }
      
      // Return top 25 paths for AI to consider (increased for better variety)
      return relevantPaths.slice(0, 25);
    };

    context.log('Filtering relevant career paths...');
    const filteredCareerPaths = filterRelevantCareerPaths(allCareerPaths, userProfile);
    context.log('Filtered career paths:', filteredCareerPaths.length);

    // Enhanced prompt based on career stage and user profile
    let prompt = `Based on the following user profile, recommend the top 5 career paths from the provided list. `;
    
    if (careerStage === "Pathfinder") {
      prompt += `User is a Pathfinder (someone exploring career options). Focus on providing diverse entry-level opportunities that match their interests and potential.\n\n`;
    } else if (careerStage === "Trailblazer") {
      prompt += `User is a Trailblazer (someone advancing in their current field). IMPORTANT: Their current path should be the #1 recommendation with the highest match score (95-100%) as they want to advance in their existing career. The other 4 recommendations should be related or complementary paths.\n\n`;
    } else if (careerStage === "Horizon Changer") {
      prompt += `User is a Horizon Changer (someone looking to change careers). Focus on diverse alternatives that leverage their existing skills while offering new challenges. Their current path can be included but should not dominate the recommendations.\n\n`;
    }

    if (careerStage === "Pathfinder") {
      prompt += `User details:
      - Education: ${userProfile.education || 'Not specified'}
      - Program: ${userProfile.program || 'Not specified'}
      - Current Skills: ${userProfile.currentSkills.join(', ') || 'Not specified'}
      - Interested Skills: ${userProfile.interestedSkills.join(', ') || 'Not specified'}
      - Interests: ${userProfile.interests.join(', ') || 'Not specified'}
      - Interested Fields: ${userProfile.interestedFields.join(', ') || 'Not specified'}
      - Preferred Work Environment: ${userProfile.workEnvironment || 'Not specified'}
      `;
    } else if (careerStage === "Trailblazer") {
      prompt += `User details:
      - Current Path: ${userProfile.currentPath || 'Not specified'}
      - Years of Experience: ${userProfile.yearsExperience || 'Not specified'}
      - Seniority Level: ${userProfile.seniorityLevel || 'Not specified'}
      - Education: ${userProfile.education || 'Not specified'}
      - Program: ${userProfile.program || 'Not specified'}
      - Current Skills: ${userProfile.currentSkills.join(', ') || 'Not specified'}
      - Interested Skills: ${userProfile.interestedSkills.join(', ') || 'Not specified'}
      - Interests: ${userProfile.interests.join(', ') || 'Not specified'}
      - Interested Fields: ${userProfile.interestedFields.join(', ') || 'Not specified'}
      - Career Goals: ${userProfile.careerGoals || 'Not specified'}
      `;
    } else if (careerStage === "Horizon Changer") {
      prompt += `User details:
      - Current Path: ${userProfile.currentPath || 'Not specified'}
      - Years of Experience: ${userProfile.yearsExperience || 'Not specified'}
      - Seniority Level: ${userProfile.seniorityLevel || 'Not specified'}
      - Education: ${userProfile.education || 'Not specified'}
      - Program: ${userProfile.program || 'Not specified'}
      - Current Skills: ${userProfile.currentSkills.join(', ') || 'Not specified'}
      - Interested Skills: ${userProfile.interestedSkills.join(', ') || 'Not specified'}
      - Interests: ${userProfile.interests.join(', ') || 'Not specified'}
      - Interested Fields: ${userProfile.interestedFields.join(', ') || 'Not specified'}
      - Current Work Environment: ${userProfile.currentWorkEnvironment || 'Not specified'}
      - Preferred Work Environment: ${userProfile.preferredWorkEnvironment || 'Not specified'}
      - Reason for Change: ${userProfile.reasonForChange || 'Not specified'}
      - Change Urgency: ${userProfile.changeUrgency || 'Not specified'}
      `;
    }

    prompt += `\nAvailable Career Paths (pre-filtered for relevance):\n`;
    filteredCareerPaths.forEach(path => {
      prompt += `- ${path.title} (ID: ${path.$id})\n`;
      prompt += `  Industry: ${path.industry || 'Not specified'}\n`;
      prompt += `  Description: ${path.description || 'No description'}\n`;
      prompt += `  Required Skills: ${path.requiredSkills?.join(', ') || 'None specified'}\n`;
      prompt += `  Required Interests: ${path.requiredInterests?.join(', ') || 'None specified'}\n`;
      prompt += `  Suggested Degrees: ${path.suggestedDegrees?.join(', ') || 'None specified'}\n`;
      prompt += `  Salary Range: ${path.minSalary && path.maxSalary ? `$${path.minSalary} - $${path.maxSalary}` : 'Not specified'}\n`;
      if (path.relevanceScore) prompt += `  Relevance Score: ${path.relevanceScore}\n`;
      prompt += `\n`;
    });

    // Stage-specific instructions
    if (careerStage === "Trailblazer") {
      prompt += `\nCRITICAL INSTRUCTIONS FOR TRAILBLAZER:
      1. The user's current path "${userProfile.currentPath}" should be the #1 recommendation with match score 95-100%
      2. Find the career path that most closely matches their current path and make it the top recommendation
      3. The remaining 4 recommendations should be advancement opportunities or specializations within their field
      4. Focus on career growth and skill development in their existing domain
      `;
    } else if (careerStage === "Horizon Changer") {
      prompt += `\nINSTRUCTIONS FOR HORIZON CHANGER:
      1. Prioritize paths that leverage their existing skills but offer new challenges
      2. Consider their reason for change: ${userProfile.reasonForChange}
      3. Focus on transferable skills from their current path: ${userProfile.currentPath}
      4. Provide diverse options across different industries/roles
      `;
    } else {
      prompt += `\nINSTRUCTIONS FOR PATHFINDER:
      1. Focus on entry-level opportunities that match their interests and education
      2. Provide diverse options across different industries and skill requirements
      3. Consider their preferred work environment and interests
      `;
    }

    prompt += `\nProvide your response in JSON format with this structure:
    {
      "recommendations": [
        {
          "pathId": "career_path_id_1",
          "title": "Career Path Title 1",
          "matchScore": 90,
          "reason": "Detailed explanation why this is a good match based on specific user interests/skills/background",
          "improvementAreas": ["skill1", "skill2"]
        },
        // ... 4 more recommendations
      ],
      "generalAdvice": "Career stage-specific advice based on the user's profile and selected recommendations"
    }`;

    context.log('Calling Gemini AI...');

    // Get AI response
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    context.log('Gemini AI response received, length:', text.length);

    // Parse the JSON response
    let jsonResponse;
    try {
      // Clean the response text to remove any markdown formatting
      const cleanedText = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      jsonResponse = JSON.parse(cleanedText);
    } catch (e) {
      context.error("Failed to parse AI response:", text);
      // If JSON parsing fails, try to extract JSON from text
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          jsonResponse = JSON.parse(jsonMatch[0]);
        } catch (e2) {
          throw new Error("Failed to parse AI response as JSON");
        }
      } else {
        throw new Error("No valid JSON found in AI response");
      }
    }

    // Validate the response structure
    if (!jsonResponse.recommendations || !Array.isArray(jsonResponse.recommendations)) {
      context.error("Invalid response structure from AI:", jsonResponse);
      throw new Error("Invalid response structure from AI");
    }

    // Ensure we have exactly 5 recommendations
    if (jsonResponse.recommendations.length < 5) {
      context.error("AI did not provide enough recommendations:", jsonResponse.recommendations.length);
      throw new Error("AI did not provide enough recommendations");
    }

    context.log('Updating user testTaken status...');

    // Update user's testTaken status
    await databases.updateDocument(
      DATABASE_ID,
      TALENTS_COLLECTION_ID,
      userData.$id,
      {
        testTaken: true
      }
    );

    // Prepare the response data
    const responseData = {
      success: true,
      recommendations: jsonResponse.recommendations.slice(0, 5), // Ensure only top 5
      generalAdvice: jsonResponse.generalAdvice || `Continue developing your skills and exploring opportunities in your areas of interest as a ${careerStage}.`,
      careerStage,
      totalPathsConsidered: allCareerPaths.length,
      filteredPathsConsidered: filteredCareerPaths.length,
      userCurrentPath: userProfile.currentPath
    };

    context.log('Career match completed successfully - Total paths:', allCareerPaths.length, 'Filtered paths:', filteredCareerPaths.length, 'Career stage:', careerStage);

    // Return the response using the correct Appwrite Cloud Function format
    return context.res.json(responseData);

  } catch (error) {
    context.error("Error in careerMatch function:", error);
    
    const errorResponse = {
      success: false,
      error: error.message || "An unknown error occurred"
    };
    
    // Return error response using the correct Appwrite Cloud Function format
    return context.res.json(errorResponse);
  }
}